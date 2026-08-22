import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { env } from "../../config/env.js";
import { s3 } from "../../db/s3.js";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import type {
  HealthCheckResult,
  ReadinessResult,
} from "./health.interfaces.js";

export const checkReadiness = async (): Promise<ReadinessResult> => {
  const checks: HealthCheckResult = { database: "ok", storage: "ok" };

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    checks.database = "error";
    logger.error(
      { error, component: "health" },
      "Database readiness check failed",
    );
  }

  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.AWS_S3_BUCKET_NAME }));
  } catch (error) {
    checks.storage = "error";
    logger.error(
      { error, component: "health" },
      "Storage readiness check failed",
    );
  }

  const ok = checks.database === "ok" && checks.storage === "ok";
  return { status: ok ? "ok" : "degraded", checks };
};
