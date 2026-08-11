import bcrypt from "bcryptjs";
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
  RegisterUserInput,
} from "./auth.interfaces.js";

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const signToken = (payload: JwtPayload): string =>
  jwt.sign(payload, env.JWT_SECRET, { expiresIn: AUTH.JWT_EXPIRES_IN });

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

  return { token: signToken({ id: user.id, email: user.email }), user };
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

  return {
    token: signToken({ id: user.id, email: user.email }),
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
