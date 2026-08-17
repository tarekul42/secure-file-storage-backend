import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";

const app = createApp();

const registerUser = async (email: string) => {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "password123" });
  return {
    accessToken: res.body.token as string,
    refreshToken: res.body.refreshToken as string,
  };
};

describe("Refresh token flow", () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
  });

  it("login returns an access token and a refresh token", async () => {
    await registerUser("refresh@example.com");

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "refresh@example.com", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it("POST /api/auth/refresh rotates the refresh token", async () => {
    const { refreshToken } = await registerUser("refresh@example.com");

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  it("rejects reuse of an already-rotated refresh token and revokes the family", async () => {
    const { refreshToken } = await registerUser("refresh@example.com");

    const first = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });
    const rotated = first.body.refreshToken as string;

    const reuse = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });
    expect(reuse.status).toBe(401);

    const afterReuse = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: rotated });
    expect(afterReuse.status).toBe(401);
  });

  it("POST /api/auth/logout revokes the refresh token", async () => {
    const { refreshToken } = await registerUser("refresh@example.com");

    const logout = await request(app)
      .post("/api/auth/logout")
      .send({ refreshToken });
    expect(logout.status).toBe(204);

    const refresh = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });
    expect(refresh.status).toBe(401);
  });

  it("rejects an unknown refresh token", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "does-not-exist" });

    expect(res.status).toBe(401);
  });

  it("POST /api/auth/logout-all revokes every refresh token for the user", async () => {
    const { accessToken, refreshToken } = await registerUser(
      "refresh@example.com",
    );

    const res = await request(app)
      .post("/api/auth/logout-all")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(204);

    const refresh = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });
    expect(refresh.status).toBe(401);
  });
});
