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
  headSize: 50,
  etag: "test-etag",
}));

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    async send(command: { constructor: { name: string } }): Promise<unknown> {
      if (command.constructor.name === "DeleteObjectCommand") {
        throw new Error("s3 unavailable");
      }
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

describe("Delete ordering (DB first, S3 best-effort)", () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
  });

  it("removes metadata and frees quota even when the S3 delete fails", async () => {
    const register = await request(app)
      .post("/api/auth/register")
      .send({ email: "delete@example.com", password: "password123" });
    const token = register.body.token as string;

    const keyRes = await request(app)
      .post("/api/files/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "a.bin",
        fileType: "application/octet-stream",
        fileSize: 50,
      });
    const s3Key = keyRes.body.s3Key as string;

    const created = await request(app)
      .post("/api/files")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "a.bin",
        s3Key,
        fileSize: 50,
        mimeType: "application/octet-stream",
      });
    expect(created.status).toBe(201);

    const del = await request(app)
      .delete(`/api/files/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);

    const file = await prisma.file.findUnique({
      where: { id: created.body.id },
    });
    expect(file).toBeNull();

    const user = await prisma.user.findUnique({
      where: { email: "delete@example.com" },
      select: { storageUsed: true },
    });
    expect(user?.storageUsed).toBe(BigInt(0));
  });
});
