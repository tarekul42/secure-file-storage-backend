import type { Request } from "express";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const PART_SIZE = 8 * 1024 * 1024;
const MB = 1024 * 1024;
const LARGE_SIZE = 100 * MB + 1;
const PART_COUNT = Math.ceil(LARGE_SIZE / PART_SIZE);

const s3State = vi.hoisted(() => ({
  uploadId: "test-upload-1",
  objectSize: 0,
  etag: "mp-etag-1",
  completed: false,
  aborted: false,
  uploads: [] as { Key: string; UploadId: string; Initiated: Date }[],
}));

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    async send(command: {
      constructor: { name: string };
      input?: Record<string, unknown>;
    }): Promise<unknown> {
      const name = command.constructor.name;
      if (name === "CreateMultipartUploadCommand") {
        return { UploadId: s3State.uploadId, $metadata: {} };
      }
      if (name === "CompleteMultipartUploadCommand") {
        s3State.completed = true;
        return { $metadata: {} };
      }
      if (name === "AbortMultipartUploadCommand") {
        s3State.aborted = true;
        return { $metadata: {} };
      }
      if (name === "HeadObjectCommand") {
        return {
          $metadata: {},
          ContentLength: s3State.objectSize,
          ETag: `"${s3State.etag}"`,
        };
      }
      if (name === "ListMultipartUploadsCommand") {
        return { $metadata: {}, Uploads: s3State.uploads };
      }
      return { $metadata: {} };
    }
  }
  class CreateMultipartUploadCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UploadPartCommand {}
  class CompleteMultipartUploadCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class AbortMultipartUploadCommand {}
  class HeadObjectCommand {}
  class ListMultipartUploadsCommand {}
  return {
    S3Client: MockS3Client,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    HeadObjectCommand,
    ListMultipartUploadsCommand,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (): Promise<string> => "https://s3.test/part-url",
}));

const { createApp } = await import("../src/app.js");
const { prisma } = await import("../src/db/prisma.js");

const app = createApp();

const registerUser = async (email: string) => {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "password123" });
  return res.body.token as string;
};

const auth = (token: string) =>
  ({ Authorization: `Bearer ${token}` }) as Request["headers"];

const validParts = (count: number = PART_COUNT) =>
  Array.from({ length: count }, (_, index) => ({
    PartNumber: index + 1,
    ETag: `"etag-${index + 1}"`,
  }));

describe("Multipart uploads API", () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
    s3State.objectSize = 0;
    s3State.completed = false;
    s3State.aborted = false;
    s3State.uploads = [];
  });

  const start = async (token: string, overrides: object = {}) =>
    request(app)
      .post("/api/files/multipart/start")
      .set(auth(token))
      .send({
        fileName: "big.bin",
        fileType: "application/octet-stream",
        fileSize: LARGE_SIZE,
        ...overrides,
      });

  describe("POST /api/files/multipart/start", () => {
    it("creates a multipart upload and persists it", async () => {
      const token = await registerUser("owner@example.com");

      const res = await start(token);

      expect(res.status).toBe(200);
      expect(res.body.uploadId).toBe(s3State.uploadId);
      expect(res.body.s3Key).toMatch(/^.+\.bin$/);
      expect(res.body.partSize).toBe(PART_SIZE);
      expect(res.body.partCount).toBe(PART_COUNT);

      const record = await prisma.multipartUpload.findUnique({
        where: { uploadId: s3State.uploadId },
      });
      expect(record).not.toBeNull();
      expect(record?.partCount).toBe(PART_COUNT);
    });

    it("rejects files at or below the 100MB single-PUT threshold", async () => {
      const token = await registerUser("owner@example.com");
      const res = await start(token, { fileSize: 100 * MB });
      expect(res.status).toBe(400);
    });

    it("rejects files over the 5GB multipart limit", async () => {
      const token = await registerUser("owner@example.com");
      const res = await start(token, { fileSize: 5 * 1024 * 1024 * 1024 + 1 });
      expect(res.status).toBe(400);
    });

    it("rejects a disallowed content type", async () => {
      const token = await registerUser("owner@example.com");
      const res = await start(token, { fileType: "application/x-msdownload" });
      expect(res.status).toBe(400);
    });

    it("rejects the request when the quota is already consumed", async () => {
      const token = await registerUser("owner@example.com");
      await prisma.user.update({
        where: { email: "owner@example.com" },
        data: { storageUsed: 1073741824 },
      });

      const res = await start(token);
      expect(res.status).toBe(413);
    });
  });

  describe("POST /api/files/multipart/part-url", () => {
    it("returns a presigned URL for a valid part number", async () => {
      const token = await registerUser("owner@example.com");
      const { body } = await start(token);

      const res = await request(app)
        .post("/api/files/multipart/part-url")
        .set(auth(token))
        .send({ uploadId: body.uploadId, s3Key: body.s3Key, partNumber: 1 });

      expect(res.status).toBe(200);
      expect(res.body.partUrl).toBe("https://s3.test/part-url");
      expect(res.body.partNumber).toBe(1);
    });

    it("rejects an out-of-range part number", async () => {
      const token = await registerUser("owner@example.com");
      const { body } = await start(token);

      const res = await request(app)
        .post("/api/files/multipart/part-url")
        .set(auth(token))
        .send({ uploadId: body.uploadId, s3Key: body.s3Key, partNumber: 9999 });

      expect(res.status).toBe(400);
    });

    it("rejects an unknown upload id", async () => {
      const token = await registerUser("owner@example.com");

      const res = await request(app)
        .post("/api/files/multipart/part-url")
        .set(auth(token))
        .send({ uploadId: "nope", s3Key: "x/y.bin", partNumber: 1 });

      expect(res.status).toBe(404);
    });

    it("rejects another user's upload", async () => {
      const owner = await registerUser("owner@example.com");
      const other = await registerUser("other@example.com");
      const { body } = await start(owner);

      const res = await request(app)
        .post("/api/files/multipart/part-url")
        .set(auth(other))
        .send({ uploadId: body.uploadId, s3Key: body.s3Key, partNumber: 1 });

      expect(res.status).toBe(403);
    });

    it("rejects a mismatched s3Key", async () => {
      const token = await registerUser("owner@example.com");
      const { body } = await start(token);

      const res = await request(app)
        .post("/api/files/multipart/part-url")
        .set(auth(token))
        .send({
          uploadId: body.uploadId,
          s3Key: "someone/else.bin",
          partNumber: 1,
        });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/files/multipart/complete", () => {
    it("registers the file and consumes quota", async () => {
      const token = await registerUser("owner@example.com");
      const { body } = await start(token);
      s3State.objectSize = LARGE_SIZE;

      const res = await request(app)
        .post("/api/files/multipart/complete")
        .set(auth(token))
        .send({
          uploadId: body.uploadId,
          s3Key: body.s3Key,
          parts: validParts(),
        });

      expect(res.status).toBe(201);
      expect(res.body.s3Key).toBe(body.s3Key);
      expect(res.body.checksum).toBeNull();
      expect(res.body.etag).toBe(s3State.etag);
      expect(s3State.completed).toBe(true);

      const user = await prisma.user.findUnique({
        where: { email: "owner@example.com" },
        select: { storageUsed: true },
      });
      expect(user?.storageUsed).toBe(BigInt(LARGE_SIZE));

      const record = await prisma.multipartUpload.findUnique({
        where: { uploadId: body.uploadId },
      });
      expect(record?.completedAt).not.toBeNull();
    });

    it("registers sizes above the INTEGER range (2GiB) without overflow", async () => {
      // Regression: fileSize was INTEGER, which overflows at 2^31 - 1 while the
      // API advertises up to 5 GB. 3 GB exercises the broken boundary.
      const THREE_GB = 3 * 1024 * 1024 * 1024;
      const token = await registerUser("bigsize@example.com");
      await prisma.user.update({
        where: { email: "bigsize@example.com" },
        data: { storageLimit: BigInt(6 * 1024 * 1024 * 1024) },
      });
      s3State.objectSize = THREE_GB;

      const started = await start(token, { fileSize: THREE_GB });
      expect(started.status).toBe(200);

      const res = await request(app)
        .post("/api/files/multipart/complete")
        .set(auth(token))
        .send({
          uploadId: started.body.uploadId,
          s3Key: started.body.s3Key,
          parts: validParts(Math.ceil(THREE_GB / PART_SIZE)),
        });

      expect(res.status).toBe(201);
      expect(res.body.fileSize).toBe(THREE_GB);

      const row = await prisma.file.findUnique({
        where: { id: res.body.id },
      });
      expect(row?.fileSize).toBe(BigInt(THREE_GB));

      const user = await prisma.user.findUnique({
        where: { email: "bigsize@example.com" },
        select: { storageUsed: true },
      });
      expect(user?.storageUsed).toBe(BigInt(THREE_GB));
    });

    it("rejects a size mismatch between the assembled object and the registered size", async () => {
      const token = await registerUser("owner@example.com");
      const { body } = await start(token);
      s3State.objectSize = LARGE_SIZE - 1;

      const res = await request(app)
        .post("/api/files/multipart/complete")
        .set(auth(token))
        .send({
          uploadId: body.uploadId,
          s3Key: body.s3Key,
          parts: validParts(),
        });

      expect(res.status).toBe(400);
      const user = await prisma.user.findUnique({
        where: { email: "owner@example.com" },
        select: { storageUsed: true },
      });
      expect(user?.storageUsed).toBe(BigInt(0));
    });

    it("rejects a missing part", async () => {
      const token = await registerUser("owner@example.com");
      const { body } = await start(token);
      s3State.objectSize = LARGE_SIZE;

      const res = await request(app)
        .post("/api/files/multipart/complete")
        .set(auth(token))
        .send({
          uploadId: body.uploadId,
          s3Key: body.s3Key,
          parts: validParts(PART_COUNT - 1),
        });

      expect(res.status).toBe(400);
    });

    it("rejects duplicate parts", async () => {
      const token = await registerUser("owner@example.com");
      const { body } = await start(token);
      s3State.objectSize = LARGE_SIZE;

      const parts = validParts();
      parts[PART_COUNT - 1] = { PartNumber: 1, ETag: '"dup"' };

      const res = await request(app)
        .post("/api/files/multipart/complete")
        .set(auth(token))
        .send({ uploadId: body.uploadId, s3Key: body.s3Key, parts });

      expect(res.status).toBe(400);
    });

    it("rejects completion after abort", async () => {
      const token = await registerUser("owner@example.com");
      const { body } = await start(token);

      await request(app)
        .post("/api/files/multipart/abort")
        .set(auth(token))
        .send({ uploadId: body.uploadId, s3Key: body.s3Key });

      const res = await request(app)
        .post("/api/files/multipart/complete")
        .set(auth(token))
        .send({
          uploadId: body.uploadId,
          s3Key: body.s3Key,
          parts: validParts(),
        });

      expect(res.status).toBe(409);
      expect(s3State.completed).toBe(false);
    });
  });

  describe("POST /api/files/multipart/abort", () => {
    it("aborts the upload and marks the record", async () => {
      const token = await registerUser("owner@example.com");
      const { body } = await start(token);

      const res = await request(app)
        .post("/api/files/multipart/abort")
        .set(auth(token))
        .send({ uploadId: body.uploadId, s3Key: body.s3Key });

      expect(res.status).toBe(204);
      expect(s3State.aborted).toBe(true);

      const record = await prisma.multipartUpload.findUnique({
        where: { uploadId: body.uploadId },
      });
      expect(record?.abortedAt).not.toBeNull();

      const partRes = await request(app)
        .post("/api/files/multipart/part-url")
        .set(auth(token))
        .send({ uploadId: body.uploadId, s3Key: body.s3Key, partNumber: 1 });
      expect(partRes.status).toBe(409);
    });

    it("rejects aborting another user's upload", async () => {
      const owner = await registerUser("owner@example.com");
      const other = await registerUser("other@example.com");
      const { body } = await start(owner);

      const res = await request(app)
        .post("/api/files/multipart/abort")
        .set(auth(other))
        .send({ uploadId: body.uploadId, s3Key: body.s3Key });

      expect(res.status).toBe(403);
    });
  });
});
