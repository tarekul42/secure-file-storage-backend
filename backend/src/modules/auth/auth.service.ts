import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { ApiError } from "../../utils/errors.js";
import { AUTH } from "./auth.constants.js";
import type {
  AuthResult,
  AuthUser,
  ForgotPasswordInput,
  JwtPayload,
  LoginUserInput,
  RefreshResult,
  RegisterUserInput,
  ResetPasswordInput,
} from "./auth.interfaces.js";
import { devMailer, type Mailer } from "./mailer.js";

let mailer: Mailer = devMailer;
export function configureMailer(m: Mailer) {
  mailer = m;
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const signAccessToken = (payload: JwtPayload): string =>
  jwt.sign(payload, env.JWT_SECRET, { expiresIn: AUTH.JWT_EXPIRES_IN });

const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const generateRefreshToken = (): string =>
  crypto.randomBytes(48).toString("base64url");

// Generate a fresh dummy hash using the configured bcrypt cost at
// startup so the timing match is exact regardless of BCRYPT_COST.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  "dummy-timing-placeholder",
  env.BCRYPT_COST,
);

const toAuthUser = (user: {
  id: string;
  email: string;
  role: "USER" | "ADMIN";
  isVerified: boolean;
  storageUsed: bigint;
  storageLimit: bigint;
  createdAt: Date;
}): AuthUser => ({
  id: user.id,
  email: user.email,
  role: user.role,
  isVerified: user.isVerified,
  storageUsed: Number(user.storageUsed),
  storageLimit: Number(user.storageLimit),
  createdAt: user.createdAt,
});

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
    data: {
      email,
      password: hashedPassword,
      storageLimit: BigInt(env.DEFAULT_STORAGE_LIMIT_BYTES),
    },
    select: {
      id: true,
      email: true,
      role: true,
      isVerified: true,
      tokenVersion: true,
      storageUsed: true,
      storageLimit: true,
      createdAt: true,
    },
  });

  const refreshToken = await createRefreshTokenRecord(
    user.id,
    crypto.randomUUID(),
  );

  return {
    token: signAccessToken({
      id: user.id,
      email: user.email,
      tokenVersion: user.tokenVersion,
    }),
    refreshToken,
    user: toAuthUser(user),
  };
};

export const loginUser = async (input: LoginUserInput): Promise<AuthResult> => {
  const email = normalizeEmail(input.email);

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      password: true,
      role: true,
      isVerified: true,
      tokenVersion: true,
      storageUsed: true,
      storageLimit: true,
      createdAt: true,
    },
  });
  if (!user) {
    await bcrypt.compare(input.password, DUMMY_PASSWORD_HASH);
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
    token: signAccessToken({
      id: user.id,
      email: user.email,
      tokenVersion: user.tokenVersion,
    }),
    refreshToken,
    user: toAuthUser(user),
  };
};

export const getUserById = async (userId: string): Promise<AuthUser> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      isVerified: true,
      storageUsed: true,
      storageLimit: true,
      createdAt: true,
    },
  });

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  return toAuthUser(user);
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
    include: {
      user: { select: { id: true, email: true, tokenVersion: true } },
    },
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

  // Rotation must be atomic: creating the successor and marking the current
  // token as replaced happen together, so a crash mid-way cannot leave an
  // orphan that is still valid for another refresh.
  const newPlaintext = await prisma.$transaction(async (tx) => {
    const plaintext = generateRefreshToken();
    const newRecord = await tx.refreshToken.create({
      data: {
        tokenHash: hashToken(plaintext),
        familyId: record.familyId,
        userId: record.userId,
        expiresAt: new Date(Date.now() + AUTH.REFRESH_TOKEN_TTL_MS),
      },
    });

    await tx.refreshToken.update({
      where: { id: record.id },
      data: { replacedById: newRecord.id },
    });

    return plaintext;
  });

  return {
    token: signAccessToken({
      id: record.user.id,
      email: record.user.email,
      tokenVersion: record.user.tokenVersion,
    }),
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

  await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
};

// ---------------------------------------------------------------------------
// Password reset

export const forgotPassword = async (
  input: ForgotPasswordInput,
): Promise<void> => {
  const email = normalizeEmail(input.email);

  // Always resolve to the same response regardless of whether the
  // account exists — prevents email enumeration.
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;

  // Invalidate any previously issued unused reset tokens for this user.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const plaintext = crypto.randomBytes(32).toString("base64url");
  await prisma.passwordResetToken.create({
    data: {
      tokenHash: hashToken(plaintext),
      userId: user.id,
      expiresAt: new Date(Date.now() + AUTH.RESET_TOKEN_TTL_MS),
    },
  });

  const resetUrl = `${env.FRONTEND_ORIGIN}/reset-password?token=${encodeURIComponent(plaintext)}`;
  await mailer.sendPasswordReset(email, resetUrl);
};

export const resetPassword = async (
  input: ResetPasswordInput,
): Promise<void> => {
  const tokenHash = hashToken(input.token);

  const record = await prisma.passwordResetToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { user: { select: { id: true } } },
  });

  if (!record) {
    throw new ApiError(401, "Invalid or expired reset token");
  }

  const hashedPassword = await bcrypt.hash(input.password, env.BCRYPT_COST);

  await prisma.$transaction(async (tx) => {
    // Mark token single-use.
    await tx.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    // Set new password.
    await tx.user.update({
      where: { id: record.userId },
      data: { password: hashedPassword },
    });
    // Invalidate every active session for this user.
    await tx.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.user.update({
      where: { id: record.userId },
      data: { tokenVersion: { increment: 1 } },
    });
  });
};
