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

const s3State = vi.hoisted(() => ({
  headSize: 10,
  etag: "test-etag",
}));

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    async send(command: { constructor: { name: string } }): Promise<unknown> {
      if (command.constructor.name === "HeadObjectCommand") {
        return {
          $metadata: {},
          ContentLength: s3State.headSize,
          ETag: `"${s3State.etag}"`,
        };
      }
      return { $metadata: {} };
    }
  }
  class PutObjectCommand {}
  class GetObjectCommand {}
  class DeleteObjectCommand {}
  class HeadObjectCommand {}
  return {
    S3Client: MockS3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    HeadObjectCommand,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (): Promise<string> => "https://s3.test/presigned-url",
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

describe("Files API", () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
    s3State.headSize = 10;
  });

  describe("POST /api/files/upload-url", () => {
    it("returns a presigned upload URL for a valid request", async () => {
      const token = await registerUser("owner@example.com");

      const res = await request(app)
        .post("/api/files/upload-url")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fileName: "report.pdf",
          fileType: "application/pdf",
          fileSize: 1000,
        });

      expect(res.status).toBe(200);
      expect(res.body.uploadUrl).toBe("https://s3.test/presigned-url");
      expect(res.body.s3Key).toMatch(/^.+\.pdf$/);
    });

    it("rejects a file over the size limit with 400", async () => {
      const token = await registerUser("owner@example.com");
      const overLimit = 100 * 1024 * 1024 + 1;

      const res = await request(app)
        .post("/api/files/upload-url")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fileName: "big.bin",
          fileType: "application/octet-stream",
          fileSize: overLimit,
        });

      expect(res.status).toBe(400);
    });

    it("returns 401 without a token", async () => {
      const res = await request(app)
        .post("/api/files/upload-url")
        .send({ fileName: "a.txt", fileType: "text/plain", fileSize: 10 });

      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/files (metadata registration)", () => {
    it("registers metadata for an owner-namespaced key", async () => {
      const token = await registerUser("owner@example.com");
      const auth = { Authorization: `Bearer ${token}` } as Request["headers"];

      const keyRes = await request(app)
        .post("/api/files/upload-url")
        .set("Authorization", `Bearer ${token}`)
        .send({ fileName: "photo.png", fileType: "image/png", fileSize: 5000 });
      const s3Key = keyRes.body.s3Key as string;

      s3State.headSize = 5000;
      const res = await request(app)
        .post("/api/files")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fileName: "photo.png",
          s3Key,
          fileSize: 5000,
          mimeType: "image/png",
        });

      expect(res.status).toBe(201);
      expect(res.body.s3Key).toBe(s3Key);
      expect(res.body.visibility).toBe("PRIVATE");
      expect(auth).toBeDefined();
    });

    it("rejects registering a key that is not owned by the caller", async () => {
      const token = await registerUser("owner@example.com");
      const otherKey = "someone-else/uuid-file.txt";

      const res = await request(app)
        .post("/api/files")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fileName: "x.txt",
          s3Key: otherKey,
          fileSize: 10,
          mimeType: "text/plain",
        });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/files (list)", () => {
    it("returns only the caller's files", async () => {
      const tokenA = await registerUser("ownerA@example.com");
      const tokenB = await registerUser("ownerB@example.com");

      const keyResA = await request(app)
        .post("/api/files/upload-url")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ fileName: "a.txt", fileType: "text/plain", fileSize: 10 });
      await request(app)
        .post("/api/files")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({
          fileName: "a.txt",
          s3Key: keyResA.body.s3Key,
          fileSize: 10,
          mimeType: "text/plain",
        });

      const res = await request(app)
        .get("/api/files")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.files).toHaveLength(0);
      expect(res.body.nextCursor).toBeNull();
    });
  });

  describe("PATCH /api/files/:id (visibility)", () => {
    it("lets the owner toggle a file public", async () => {
      const token = await registerUser("owner@example.com");
      const keyRes = await request(app)
        .post("/api/files/upload-url")
        .set("Authorization", `Bearer ${token}`)
        .send({ fileName: "a.txt", fileType: "text/plain", fileSize: 10 });
      const created = await request(app)
        .post("/api/files")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fileName: "a.txt",
          s3Key: keyRes.body.s3Key,
          fileSize: 10,
          mimeType: "text/plain",
        });

      const res = await request(app)
        .patch(`/api/files/${created.body.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ visibility: "PUBLIC" });

      expect(res.status).toBe(200);
      expect(res.body.visibility).toBe("PUBLIC");
      expect(res.body.updatedAt).toBeTruthy();
    });

    it("forbids a non-owner from toggling visibility", async () => {
      const tokenOwner = await registerUser("owner@example.com");
      const tokenOther = await registerUser("other@example.com");

      const keyRes = await request(app)
        .post("/api/files/upload-url")
        .set("Authorization", `Bearer ${tokenOwner}`)
        .send({ fileName: "a.txt", fileType: "text/plain", fileSize: 10 });

      const created = await request(app)
        .post("/api/files")
        .set("Authorization", `Bearer ${tokenOwner}`)
        .send({
          fileName: "a.txt",
          s3Key: keyRes.body.s3Key,
          fileSize: 10,
          mimeType: "text/plain",
        });

      const res = await request(app)
        .patch(`/api/files/${created.body.id}`)
        .set("Authorization", `Bearer ${tokenOther}`)
        .send({ visibility: "PUBLIC" });

      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/files/:id/share (public link)", () => {
    it("returns a download URL when the file is public", async () => {
      const token = await registerUser("owner@example.com");
      const keyRes = await request(app)
        .post("/api/files/upload-url")
        .set("Authorization", `Bearer ${token}`)
        .send({ fileName: "a.txt", fileType: "text/plain", fileSize: 10 });
      const created = await request(app)
        .post("/api/files")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fileName: "a.txt",
          s3Key: keyRes.body.s3Key,
          fileSize: 10,
          mimeType: "text/plain",
        });
      await request(app)
        .patch(`/api/files/${created.body.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ visibility: "PUBLIC" });

      const res = await request(app).get(`/api/files/${created.body.id}/share`);

      expect(res.status).toBe(200);
      expect(res.body.downloadUrl).toBe("https://s3.test/presigned-url");
    });

    it("returns 403 when the file is private", async () => {
      const token = await registerUser("owner@example.com");
      const keyRes = await request(app)
        .post("/api/files/upload-url")
        .set("Authorization", `Bearer ${token}`)
        .send({ fileName: "a.txt", fileType: "text/plain", fileSize: 10 });
      const created = await request(app)
        .post("/api/files")
        .set("Authorization", `Bearer ${token}`)
        .send({
          fileName: "a.txt",
          s3Key: keyRes.body.s3Key,
          fileSize: 10,
          mimeType: "text/plain",
        });

      const res = await request(app).get(`/api/files/${created.body.id}/share`);
      expect(res.status).toBe(403);
    });
  });
});
