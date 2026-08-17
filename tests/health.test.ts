import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";

const app = createApp();

describe("Health API", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("GET /health returns liveness", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
  });

  it("GET /health/ready reports database and storage checks", async () => {
    const res = await request(app).get("/health/ready");

    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty("status");
    expect(res.body.checks).toHaveProperty("database");
    expect(res.body.checks).toHaveProperty("storage");
    expect(["ok", "error"]).toContain(res.body.checks.database);
    expect(["ok", "error"]).toContain(res.body.checks.storage);
  });
});

describe("Request ID middleware", () => {
  it("sets an X-Request-Id header on every response", async () => {
    const res = await request(app).get("/health");

    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("propagates a caller-supplied X-Request-Id", async () => {
    const res = await request(app)
      .get("/health")
      .set("X-Request-Id", "trace-id-123");

    expect(res.headers["x-request-id"]).toBe("trace-id-123");
  });
});
