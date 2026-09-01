import crypto from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";

const app = createApp();

const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

describe("Password reset API", () => {
  const email = "reset-test@example.com";
  const password = "oldpassword123";
  let userId: string;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');

    // Register a user to test against.
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email, password });

    userId = res.body.user.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("POST /api/auth/forgot-password", () => {
    it("returns 200 even for a non-existent email (no enumeration)", async () => {
      const res = await request(app)
        .post("/api/auth/forgot-password")
        .send({ email: "nonexistent@example.com" });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/reset link/i);
    });

    it("returns 200 for an existing email", async () => {
      const res = await request(app)
        .post("/api/auth/forgot-password")
        .send({ email });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/reset link/i);
    });

    it("creates a PasswordResetToken record in the database", async () => {
      const tokens = await prisma.passwordResetToken.findMany({
        where: { userId },
      });
      expect(tokens.length).toBeGreaterThanOrEqual(1);
      expect(tokens[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(tokens[0]!.usedAt).toBeNull();
    });

    it("invalidates previous unused tokens when a new one is requested", async () => {
      // Request another reset.
      await request(app).post("/api/auth/forgot-password").send({ email });

      const tokens = await prisma.passwordResetToken.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });

      // All tokens except the most recent should be marked as used.
      const usedTokens = tokens.filter((t) => t.usedAt !== null);
      expect(usedTokens.length).toBe(tokens.length - 1);
    });

    it("rejects an invalid email format with 400", async () => {
      const res = await request(app)
        .post("/api/auth/forgot-password")
        .send({ email: "not-an-email" });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/auth/reset-password", () => {
    const resetToken = crypto.randomBytes(32).toString("base64url");

    beforeAll(async () => {
      // Manually insert a valid reset token.
      await prisma.passwordResetToken.create({
        data: {
          tokenHash: hashToken(resetToken),
          userId,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });
    });

    it("rejects an invalid token with 401", async () => {
      const res = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: "invalid-token", password: "newpassword123" });

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/invalid or expired/i);
    });

    it("rejects an expired token with 401", async () => {
      const expiredToken = crypto.randomBytes(32).toString("base64url");
      await prisma.passwordResetToken.create({
        data: {
          tokenHash: hashToken(expiredToken),
          userId,
          expiresAt: new Date(Date.now() - 1000),
        },
      });

      const res = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: expiredToken, password: "newpassword123" });

      expect(res.status).toBe(401);
    });

    it("resets the password successfully with a valid token", async () => {
      const newPassword = "newpassword456";
      const res = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: resetToken, password: newPassword });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/password reset successfully/i);

      // Old password should no longer work.
      const oldLogin = await request(app)
        .post("/api/auth/login")
        .send({ email, password });
      expect(oldLogin.status).toBe(401);

      // New password should work.
      const newLogin = await request(app)
        .post("/api/auth/login")
        .send({ email, password: newPassword });
      expect(newLogin.status).toBe(200);
      expect(newLogin.body.token).toBeTruthy();
    });

    it("marks the token as used after a successful reset", async () => {
      const tokenRecord = await prisma.passwordResetToken.findFirst({
        where: { tokenHash: hashToken(resetToken) },
      });
      expect(tokenRecord).not.toBeNull();
      expect(tokenRecord!.usedAt).not.toBeNull();
    });

    it("prevents token reuse", async () => {
      const res = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: resetToken, password: "anotherpassword789" });

      expect(res.status).toBe(401);
    });

    it("revokes all refresh tokens after password reset", async () => {
      // Create a session before reset.
      const loginBefore = await request(app)
        .post("/api/auth/login")
        .send({ email, password: "newpassword456" });
      expect(loginBefore.status).toBe(200);
      const oldRefreshToken = loginBefore.body.refreshToken as string;

      // Request a new reset.
      await request(app).post("/api/auth/forgot-password").send({ email });

      // Get the latest token hash.
      const latestToken = await prisma.passwordResetToken.findFirst({
        where: { userId, usedAt: null },
        orderBy: { createdAt: "desc" },
      });
      expect(latestToken).not.toBeNull();

      // We need the plaintext — insert a known one.
      const freshResetToken = crypto.randomBytes(32).toString("base64url");
      // Mark the auto-generated one as used so we can use our known one.
      if (latestToken) {
        await prisma.passwordResetToken.update({
          where: { id: latestToken.id },
          data: { usedAt: new Date() },
        });
      }
      await prisma.passwordResetToken.create({
        data: {
          tokenHash: hashToken(freshResetToken),
          userId,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      // Reset with the known token.
      const resetRes = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: freshResetToken, password: "finalpass123" });
      expect(resetRes.status).toBe(200);

      // The pre-reset refresh token should now be revoked.
      const oldRefreshRecord = await prisma.refreshToken.findFirst({
        where: { tokenHash: hashToken(oldRefreshToken) },
      });
      expect(oldRefreshRecord!.revokedAt).not.toBeNull();
    });

    it("rejects a short password with 400", async () => {
      const anotherToken = crypto.randomBytes(32).toString("base64url");
      await prisma.passwordResetToken.create({
        data: {
          tokenHash: hashToken(anotherToken),
          userId,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      const res = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: anotherToken, password: "short" });

      expect(res.status).toBe(400);
    });
  });
});
