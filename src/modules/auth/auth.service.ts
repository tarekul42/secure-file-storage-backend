import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { ApiError } from "../../utils/errors.js";
import { AUTH } from "./auth.constants.js";
import type {
  AuthResult,
  AuthUser,
  JwtPayload,
  LoginUserInput,
  RefreshResult,
  RegisterUserInput,
} from "./auth.interfaces.js";

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const signAccessToken = (payload: JwtPayload): string =>
  jwt.sign(payload, env.JWT_SECRET, { expiresIn: AUTH.JWT_EXPIRES_IN });

const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const generateRefreshToken = (): string =>
  crypto.randomBytes(48).toString("base64url");

const createRefreshTokenRecord = async (
  userId: string,
  familyId: string,
): Promise<string> => {
  const plaintext = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(plaintext),
      familyId,
      userId,
      expiresAt: new Date(Date.now() + AUTH.REFRESH_TOKEN_TTL_MS),
    },
  });
  return plaintext;
};

export const registerUser = async (
  input: RegisterUserInput,
): Promise<AuthResult> => {
  const email = normalizeEmail(input.email);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ApiError(409, "An account with this email already exists");
  }

  const hashedPassword = await bcrypt.hash(
    input.password,
    AUTH.BCRYPT_SALT_ROUNDS,
  );

  const user = await prisma.user.create({
    data: { email, password: hashedPassword },
    select: { id: true, email: true, createdAt: true },
  });

  const refreshToken = await createRefreshTokenRecord(
    user.id,
    crypto.randomUUID(),
  );

  return {
    token: signAccessToken({ id: user.id, email: user.email }),
    refreshToken,
    user,
  };
};

export const loginUser = async (input: LoginUserInput): Promise<AuthResult> => {
  const email = normalizeEmail(input.email);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new ApiError(401, "Invalid email or password");
  }

  const passwordValid = await bcrypt.compare(input.password, user.password);
  if (!passwordValid) {
    throw new ApiError(401, "Invalid email or password");
  }

  const refreshToken = await createRefreshTokenRecord(
    user.id,
    crypto.randomUUID(),
  );

  return {
    token: signAccessToken({ id: user.id, email: user.email }),
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
    },
  };
};

export const getUserById = async (userId: string): Promise<AuthUser> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, createdAt: true },
  });

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  return user;
};

const revokeFamily = async (familyId: string): Promise<void> => {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

export const refreshAccessToken = async (
  refreshToken: string,
): Promise<RefreshResult> => {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
    include: { user: { select: { id: true, email: true } } },
  });

  if (!record) {
    throw new ApiError(401, "Invalid refresh token");
  }

  if (record.revokedAt !== null) {
    throw new ApiError(401, "Refresh token revoked");
  }

  if (record.replacedById !== null) {
    await revokeFamily(record.familyId);
    throw new ApiError(401, "Refresh token reuse detected; session revoked");
  }

  if (record.expiresAt < new Date()) {
    throw new ApiError(401, "Refresh token expired");
  }

  const newPlaintext = generateRefreshToken();
  const newRecord = await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(newPlaintext),
      familyId: record.familyId,
      userId: record.userId,
      expiresAt: new Date(Date.now() + AUTH.REFRESH_TOKEN_TTL_MS),
    },
  });

  await prisma.refreshToken.update({
    where: { id: record.id },
    data: { replacedById: newRecord.id },
  });

  return {
    token: signAccessToken({ id: record.user.id, email: record.user.email }),
    refreshToken: newPlaintext,
  };
};

export const revokeRefreshToken = async (
  refreshToken: string,
): Promise<void> => {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
  });

  if (!record) {
    throw new ApiError(401, "Invalid refresh token");
  }

  await prisma.refreshToken.update({
    where: { id: record.id },
    data: { revokedAt: new Date() },
  });
};

export const revokeAllUserTokens = async (userId: string): Promise<void> => {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
};
