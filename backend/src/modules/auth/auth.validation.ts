import { z } from "zod";
import { EMAIL_MAX_LENGTH, PASSWORD_POLICY } from "./auth.constants.js";

export const registerSchema = {
  body: z.object({
    email: z
      .string()
      .trim()
      .email("A valid email address is required")
      .max(
        EMAIL_MAX_LENGTH,
        `Email must be at most ${EMAIL_MAX_LENGTH} characters`,
      ),
    password: z
      .string()
      .min(
        PASSWORD_POLICY.MIN_LENGTH,
        `Password must be at least ${PASSWORD_POLICY.MIN_LENGTH} characters`,
      )
      .max(
        PASSWORD_POLICY.MAX_LENGTH,
        `Password must be at most ${PASSWORD_POLICY.MAX_LENGTH} characters`,
      ),
  }),
};

export const loginSchema = {
  body: z.object({
    email: z.string().trim().email("A valid email address is required"),
    password: z.string().min(1, "Password is required"),
  }),
};

export const refreshTokenSchema = {
  body: z.object({
    refreshToken: z.string().trim().min(1, "refreshToken is required"),
  }),
};

export const forgotPasswordSchema = {
  body: z.object({
    email: z.string().trim().email("A valid email address is required"),
  }),
};

export const resetPasswordSchema = {
  body: z.object({
    token: z.string().trim().min(1, "reset token is required"),
    password: z
      .string()
      .min(
        PASSWORD_POLICY.MIN_LENGTH,
        `Password must be at least ${PASSWORD_POLICY.MIN_LENGTH} characters`,
      )
      .max(
        PASSWORD_POLICY.MAX_LENGTH,
        `Password must be at most ${PASSWORD_POLICY.MAX_LENGTH} characters`,
      ),
  }),
};
