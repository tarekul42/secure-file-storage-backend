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

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    async send(): Promise<unknown> {
      return { $metadata: {} };
    }
  }
  class Command {}
  return {
    S3Client: MockS3Client,
    PutObjectCommand: Command,
    GetObjectCommand: Command,
    DeleteObjectCommand: Command,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (): Promise<string> => "https://s3.test/presigned-url",
}));

const { createApp } = await import("../src/app.js");
const { prisma } = await import("../src/db/prisma.js");

const app = createApp();

const setQuota = async (email: string, limitBytes: number) => {
  await prisma.user.update({
    where: { email },
    data: { storageLimit: BigInt(limitBytes) },
  });
};

describe("Storage quota enforcement", () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
  });

  const register = async (email: string) => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "password123" });
    return res.body.token as string;
  };

  it("rejects an upload-url request that exceeds remaining quota with 413", async () => {
    const token = await register("quota@example.com");
    await setQuota("quota@example.com", 100);

    const res = await request(app)
      .post("/api/files/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "big.bin",
        fileType: "application/octet-stream",
        fileSize: 101,
      });

    expect(res.status).toBe(413);
    expect(res.body.message).toMatch(/quota/i);
  });

  it("allows an upload-url request that fits the quota", async () => {
    const token = await register("quota@example.com");
    await setQuota("quota@example.com", 100);

    const res = await request(app)
      .post("/api/files/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "ok.bin",
        fileType: "application/octet-stream",
        fileSize: 100,
      });

    expect(res.status).toBe(200);
  });

  it("rejects metadata registration atomically when the quota would be exceeded", async () => {
    const token = await register("quota@example.com");
    await setQuota("quota@example.com", 100);

    const keyRes = await request(app)
      .post("/api/files/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "one.bin",
        fileType: "application/octet-stream",
        fileSize: 60,
      });
    const s3Key = keyRes.body.s3Key as string;

    const first = await request(app)
      .post("/api/files")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "one.bin",
        s3Key,
        fileSize: 60,
        mimeType: "application/octet-stream",
      });
    expect(first.status).toBe(201);

    const user = await prisma.user.findUnique({
      where: { email: "quota@example.com" },
      select: { id: true },
    });
    const secondKey = `${user?.id}/second-file.bin`;

    const second = await request(app)
      .post("/api/files")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "two.bin",
        s3Key: secondKey,
        fileSize: 50,
        mimeType: "application/octet-stream",
      });

    expect(second.status).toBe(413);
  });

  it("frees quota when a file is deleted", async () => {
    const token = await register("quota@example.com");
    await setQuota("quota@example.com", 100);

    const keyRes = await request(app)
      .post("/api/files/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "one.bin",
        fileType: "application/octet-stream",
        fileSize: 60,
      });
    const s3Key = keyRes.body.s3Key as string;

    const created = await request(app)
      .post("/api/files")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "one.bin",
        s3Key,
        fileSize: 60,
        mimeType: "application/octet-stream",
      });
    expect(created.status).toBe(201);

    const del = await request(app)
      .delete(`/api/files/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);

    const user = await prisma.user.findUnique({
      where: { email: "quota@example.com" },
      select: { storageUsed: true },
    });
    expect(user?.storageUsed).toBe(BigInt(0));
  });

  it("exposes storage usage in GET /api/auth/me", async () => {
    const token = await register("quota@example.com");

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.user.storageUsed).toBe("number");
    expect(typeof res.body.user.storageLimit).toBe("number");
    expect(res.body.user.storageLimit).toBe(1073741824);
  });
});
