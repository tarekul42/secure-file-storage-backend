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
  headMissing: false,
}));

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    async send(command: { constructor: { name: string } }): Promise<unknown> {
      if (command.constructor.name === "HeadObjectCommand") {
        if (s3State.headMissing) {
          throw { name: "NotFound", $metadata: { httpStatusCode: 404 } };
        }
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

const registerUser = async (email: string): Promise<string> => {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "password123" });
  return res.body.token as string;
};

describe("Content-type allow-list & size/checksum verification", () => {
  let token: string;
  let auth: Request["headers"];

  beforeAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
    token = await registerUser("safety@example.com");
    auth = { Authorization: `Bearer ${token}` } as Request["headers"];
    s3State.headMissing = false;
    s3State.headSize = 10;
  });

  it("rejects an upload-url request with a disallowed content type", async () => {
    const res = await request(app)
      .post("/api/files/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "malware.exe",
        fileType: "application/x-msdownload",
        fileSize: 10,
      });

    expect(res.status).toBe(400);
    expect(res.body.errors?.[0]?.message).toMatch(/content-type/i);
  });

  it("allows an upload-url request with an allowed content type", async () => {
    const res = await request(app)
      .post("/api/files/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "ok.json",
        fileType: "application/json",
        fileSize: 10,
      });

    expect(res.status).toBe(200);
  });

  it("rejects metadata registration with a disallowed mimeType", async () => {
    const keyRes = await request(app)
      .post("/api/files/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "a.txt",
        fileType: "text/plain",
        fileSize: 10,
      });
    const s3Key = keyRes.body.s3Key as string;

    const res = await request(app).post("/api/files").set(auth).send({
      fileName: "a.txt",
      s3Key,
      fileSize: 10,
      mimeType: "text/html",
    });

    expect(res.status).toBe(400);
    expect(res.body.errors?.[0]?.message).toMatch(/content-type/i);
  });

  it("rejects registration when the object was never uploaded", async () => {
    s3State.headMissing = true;

    const keyRes = await request(app)
      .post("/api/files/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "ghost.txt",
        fileType: "text/plain",
        fileSize: 10,
      });
    const s3Key = keyRes.body.s3Key as string;

    const res = await request(app).post("/api/files").set(auth).send({
      fileName: "ghost.txt",
      s3Key,
      fileSize: 10,
      mimeType: "text/plain",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not found|upload/i);
  });

  it("rejects registration when the uploaded size does not match", async () => {
    const keyRes = await request(app)
      .post("/api/files/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "truncated.bin",
        fileType: "application/octet-stream",
        fileSize: 100,
      });
    const s3Key = keyRes.body.s3Key as string;

    s3State.headSize = 40;
    const res = await request(app).post("/api/files").set(auth).send({
      fileName: "truncated.bin",
      s3Key,
      fileSize: 100,
      mimeType: "application/octet-stream",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/size/i);
  });

  it("stores the object etag and checksum on successful registration", async () => {
    const keyRes = await request(app)
      .post("/api/files/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "doc.txt",
        fileType: "text/plain",
        fileSize: 10,
      });
    const s3Key = keyRes.body.s3Key as string;

    const res = await request(app).post("/api/files").set(auth).send({
      fileName: "doc.txt",
      s3Key,
      fileSize: 10,
      mimeType: "text/plain",
    });

    expect(res.status).toBe(201);
    expect(res.body.etag).toBe(s3State.etag);
    expect(res.body.checksum).toBe(s3State.etag);
  });
});
