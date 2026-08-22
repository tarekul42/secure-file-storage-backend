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

  it("rolls back atomically when rotation fails after creating the successor", async () => {
    const { refreshToken } = await registerUser("rotate@example.com");
    const user = await prisma.user.findUnique({
      where: { email: "rotate@example.com" },
    });

    // Simulate a crash between the two rotation writes at the database
    // level: a trigger makes every RefreshToken UPDATE raise, so the
    // in-flight transaction must roll back BOTH the successor insert and
    // the replacedById mark.
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION tests_fail_refresh_update() RETURNS trigger AS $$
       BEGIN RAISE EXCEPTION 'simulated crash mid-rotation'; END;
       $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER tests_fail_refresh_update
       BEFORE UPDATE ON "RefreshToken"
       FOR EACH ROW EXECUTE FUNCTION tests_fail_refresh_update()`,
    );

    await request(app).post("/api/auth/refresh").send({ refreshToken });

    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS tests_fail_refresh_update ON "RefreshToken"',
    );
    await prisma.$executeRawUnsafe(
      "DROP FUNCTION IF EXISTS tests_fail_refresh_update",
    );

    const tokens = await prisma.refreshToken.findMany({
      where: { userId: user!.id },
    });
    expect(tokens).toHaveLength(1);

    const record = tokens[0];
    expect(record?.revokedAt).toBeNull();
    expect(record?.replacedById).toBeNull();

    // The original token was never marked replaced, so it must still rotate
    // cleanly — no reuse-detection false positive, no revoked family.
    const retry = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });
    expect(retry.status).toBe(200);
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

  it("logout-all invalidates outstanding access tokens via tokenVersion", async () => {
    const { accessToken } = await registerUser("refresh@example.com");

    const before = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(before.status).toBe(200);

    await request(app)
      .post("/api/auth/logout-all")
      .set("Authorization", `Bearer ${accessToken}`);

    const after = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(after.status).toBe(401);

    const relogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "refresh@example.com", password: "password123" });
    expect(relogin.status).toBe(200);

    const withNew = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${relogin.body.token}`);
    expect(withNew.status).toBe(200);
  });
});
