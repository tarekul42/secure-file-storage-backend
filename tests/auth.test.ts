import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";

const app = createApp();

describe("Auth API", () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const email = "auth-test@example.com";
  const password = "password123";

  describe("POST /api/auth/register", () => {
    it("creates an account and returns a token + user", async () => {
      const res = await request(app)
        .post("/api/auth/register")
        .send({ email, password });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("token");
      expect(res.body.user.email).toBe(email);
      expect(res.body.user).not.toHaveProperty("password");
    });

    it("rejects a duplicate email with 409", async () => {
      const res = await request(app)
        .post("/api/auth/register")
        .send({ email, password });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already exists/i);
    });

    it("rejects an invalid email with 400", async () => {
      const res = await request(app)
        .post("/api/auth/register")
        .send({ email: "not-an-email", password });

      expect(res.status).toBe(400);
      expect(res.body.errors).toBeDefined();
    });

    it("rejects a short password with 400", async () => {
      const res = await request(app)
        .post("/api/auth/register")
        .send({ email: "shortpass@example.com", password: "123" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/validation/i);
    });
  });

  describe("POST /api/auth/login", () => {
    it("logs in with valid credentials", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email, password });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.user.email).toBe(email);
    });

    it("rejects a wrong password with 401", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email, password: "wrongpass" });

      expect(res.status).toBe(401);
    });

    it("rejects a nonexistent user with 401", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "nobody@example.com", password });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns the current user with a valid token", async () => {
      const login = await request(app)
        .post("/api/auth/login")
        .send({ email, password });
      const token = login.body.token as string;

      const res = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(email);
    });

    it("returns 401 without a token", async () => {
      const res = await request(app).get("/api/auth/me");
      expect(res.status).toBe(401);
    });

    it("returns 401 with an invalid token", async () => {
      const res = await request(app)
        .get("/api/auth/me")
        .set("Authorization", "Bearer not.a.jwt");

      expect(res.status).toBe(401);
    });
  });
});
