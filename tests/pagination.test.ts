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
  class ListObjectsV2Command {}
  return {
    S3Client: MockS3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (): Promise<string> => "https://s3.test/presigned-url",
}));

const { createApp } = await import("../src/app.js");
const { prisma } = await import("../src/db/prisma.js");

const app = createApp();

const registerUser = async (email: string): Promise<string> => {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "password123" });
  return res.body.token as string;
};

const createFile = async (
  token: string,
  fileName: string,
  fileSize: number,
): Promise<string> => {
  const keyRes = await request(app)
    .post("/api/files/upload-url")
    .set("Authorization", `Bearer ${token}`)
    .send({ fileName, fileType: "application/octet-stream", fileSize });
  const created = await request(app)
    .post("/api/files")
    .set("Authorization", `Bearer ${token}`)
    .send({
      fileName,
      s3Key: keyRes.body.s3Key,
      fileSize,
      mimeType: "application/octet-stream",
    });
  return created.body.id as string;
};

describe("GET /api/files (cursor pagination)", () => {
  let token: string;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
    token = await registerUser("paginate@example.com");
  });

  it("returns the first page with a nextCursor when there are more files", async () => {
    for (let i = 0; i < 5; i += 1) {
      await createFile(token, `file-${i}.bin`, 10);
    }

    const res = await request(app)
      .get("/api/files?limit=3")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(3);
    expect(res.body.nextCursor).toBeTruthy();
  });

  it("returns no nextCursor on the last page", async () => {
    for (let i = 0; i < 3; i += 1) {
      await createFile(token, `file-${i}.bin`, 10);
    }

    const res = await request(app)
      .get("/api/files?limit=3")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.files).toHaveLength(3);
    expect(res.body.nextCursor).toBeNull();
  });

  it("walks all pages via the cursor without duplicates or gaps", async () => {
    for (let i = 0; i < 7; i += 1) {
      await createFile(token, `file-${i}.bin`, 10);
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    do {
      const query = new URLSearchParams({ limit: "3" });
      if (cursor) query.set("cursor", cursor);

      const res = await request(app)
        .get(`/api/files?${query.toString()}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      for (const file of res.body.files as Array<{ id: string }>) {
        expect(seen.has(file.id)).toBe(false);
        seen.add(file.id);
      }
      pages += 1;
      cursor = res.body.nextCursor as string | undefined;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen.size).toBe(7);
  });

  it("rejects a limit above the 50 cap", async () => {
    const res = await request(app)
      .get("/api/files?limit=500")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it("rejects an invalid cursor", async () => {
    const res = await request(app)
      .get("/api/files?cursor=not-a-uuid")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it("returns an empty page for a cursor that does not exist", async () => {
    const res = await request(app)
      .get("/api/files?cursor=00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(0);
    expect(res.body.nextCursor).toBeNull();
  });
});
