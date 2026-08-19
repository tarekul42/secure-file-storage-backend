import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { s3 } from "../db/s3.js";
import { FILE_LIMITS } from "../modules/files/file.constants.js";
import { logger } from "../utils/logger.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const APP_KEY_PATTERN = new RegExp(`^${UUID}/${UUID}-.+`);

export const isAppKey = (key: string): boolean => APP_KEY_PATTERN.test(key);

export const findOrphanedKeys = (
  dbKeys: Set<string>,
  s3Keys: string[],
): string[] => s3Keys.filter((key) => isAppKey(key) && !dbKeys.has(key));

export interface MultipartUploadSummary {
  Key: string;
  UploadId: string;
  Initiated: Date;
}

export const findStaleMultipartUploads = (
  uploads: MultipartUploadSummary[],
  staleBefore: Date,
): MultipartUploadSummary[] =>
  uploads.filter((upload) => upload.Initiated < staleBefore);

export const listAllObjectKeys = async (): Promise<string[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.AWS_S3_BUCKET_NAME,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );

    for (const item of result.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }

    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return keys;
};

const reportMissingObjects = async (): Promise<void> => {
  const rows = await prisma.file.findMany({
    select: { id: true, s3Key: true },
  });

  let missingCount = 0;
  for (const row of rows) {
    try {
      await s3.send(
        new HeadObjectCommand({
          Bucket: env.AWS_S3_BUCKET_NAME,
          Key: row.s3Key,
        }),
      );
    } catch {
      missingCount += 1;
      logger.warn(
        { id: row.id, s3Key: row.s3Key },
        "DB metadata references a missing object",
      );
    }
  }

  logger.info(
    { missingCount, checked: rows.length },
    "Missing-object scan complete",
  );
};

const reportStaleMultipartUploads = async (apply: boolean): Promise<void> => {
  const staleBefore = new Date(Date.now() - FILE_LIMITS.MULTIPART_STALE_MS);

  const result = await s3.send(
    new ListMultipartUploadsCommand({ Bucket: env.AWS_S3_BUCKET_NAME }),
  );

  const appUploads = (result.Uploads ?? []).filter(
    (upload) => upload.Key && isAppKey(upload.Key),
  ) as MultipartUploadSummary[];

  const stale = findStaleMultipartUploads(appUploads, staleBefore);

  const staleDbRecords = await prisma.multipartUpload.findMany({
    where: {
      completedAt: null,
      abortedAt: null,
      createdAt: { lt: staleBefore },
    },
  });

  logger.info(
    { s3Stale: stale.length, dbStale: staleDbRecords.length },
    "Stale multipart upload scan complete",
  );

  const doAbort = (): Promise<void> =>
    Promise.all(
      stale.map(async (upload) => {
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: env.AWS_S3_BUCKET_NAME,
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        );
        logger.info(
          { s3Key: upload.Key, uploadId: upload.UploadId },
          "Aborted stale multipart upload",
        );
      }),
    ).then(() => undefined);

  const doMark = (): Promise<unknown> =>
    prisma.multipartUpload.updateMany({
      where: { id: { in: staleDbRecords.map((record) => record.id) } },
      data: { abortedAt: new Date() },
    });

  if (apply) {
    await doAbort();
    await doMark();
  } else {
    for (const upload of stale) {
      logger.info(
        { s3Key: upload.Key, uploadId: upload.UploadId },
        "Stale multipart upload (dry-run; pass --apply to abort)",
      );
    }
    for (const record of staleDbRecords) {
      logger.info(
        { id: record.id, uploadId: record.uploadId },
        "Stale multipart DB record (dry-run; pass --apply to mark aborted)",
      );
    }
  }
};

const main = async (): Promise<void> => {
  const apply = process.argv.includes("--apply");
  const reportMissing = process.argv.includes("--missing");

  logger.info({ apply, reportMissing }, "Starting S3 reconciliation");

  const rows = await prisma.file.findMany({ select: { s3Key: true } });
  const dbKeys = new Set(rows.map((row) => row.s3Key));
  const s3Keys = await listAllObjectKeys();
  const orphans = findOrphanedKeys(dbKeys, s3Keys);

  logger.info(
    { dbFiles: rows.length, s3Objects: s3Keys.length, orphans: orphans.length },
    "Reconciliation scan complete",
  );

  if (apply) {
    for (const key of orphans) {
      await s3.send(
        new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key }),
      );
      logger.info({ s3Key: key }, "Deleted orphaned object");
    }
  } else {
    for (const key of orphans) {
      logger.info(
        { s3Key: key },
        "Orphaned object (dry-run; pass --apply to delete)",
      );
    }
  }

  if (reportMissing) {
    await reportMissingObjects();
  }

  await reportStaleMultipartUploads(apply);

  await prisma.$disconnect();
};

const isMainScript = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
};

if (isMainScript()) {
  main().catch(async (error) => {
    logger.error({ error }, "Reconciliation failed");
    await prisma.$disconnect();
    process.exit(1);
  });
}
