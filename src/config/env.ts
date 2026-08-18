import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  AWS_REGION: z.string().min(1, "AWS_REGION is required"),
  AWS_S3_BUCKET_NAME: z.string().min(1, "AWS_S3_BUCKET_NAME is required"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: z
    .string()
    .trim()
    .transform((value) => value || undefined)
    .pipe(
      z
        .string()
        .url("S3_ENDPOINT must be a valid URL (or leave empty for AWS)")
        .optional(),
    ),
  AWS_FORCE_PATH_STYLE: z
    .string()
    .trim()
    .transform((value) => value || "false")
    .pipe(z.enum(["true", "false"]))
    .transform((value) => value === "true"),
  FRONTEND_ORIGIN: z.string().default("http://localhost:3000"),
  DEFAULT_STORAGE_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1073741824),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;

export const allowedOrigins = env.FRONTEND_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
