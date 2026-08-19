import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import { env } from "../../config/env.js";
import { s3 } from "../../db/s3.js";
import { prisma } from "../../db/prisma.js";
import { ApiError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { FILE_LIMITS } from "./file.constants.js";
import type {
  AbortMultipartInput,
  CompleteMultipartInput,
  CreateFileMetadataInput,
  DownloadPublicInput,
  DownloadResult,
  GetDownloadUrlInput,
  ListFilesParams,
  ListFilesResult,
  MultipartPartUrlInput,
  MultipartPartUrlResult,
  RequestUploadInput,
  RequestUploadResult,
  StartMultipartInput,
  StartMultipartResult,
  Visibility,
} from "./file.interfaces.js";

const sanitizeFileName = (fileName: string): string =>
  fileName.replace(/[\\/]+/g, "_").slice(0, FILE_LIMITS.MAX_FILENAME_LENGTH);

const assertQuotaAvailable = async (
  userId: string,
  fileSize: number,
): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { storageUsed: true, storageLimit: true },
  });

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  if (BigInt(fileSize) > user.storageLimit - user.storageUsed) {
    throw new ApiError(413, "Storage quota exceeded");
  }
};

export const requestUploadUrl = async (
  userId: string,
  input: RequestUploadInput,
): Promise<RequestUploadResult> => {
  await assertQuotaAvailable(userId, input.fileSize);

  const safeFileName = sanitizeFileName(input.fileName);
  const s3Key = `${userId}/${crypto.randomUUID()}-${safeFileName}`;

  const command = new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET_NAME,
    Key: s3Key,
    ContentType: input.fileType,
    ContentLength: input.fileSize,
  });

  const uploadUrl = await getSignedUrl(s3, command, {
    expiresIn: FILE_LIMITS.UPLOAD_URL_EXPIRATION_MS,
  });

  return { uploadUrl, s3Key, fileName: safeFileName };
};

interface RegisterObjectInput {
  fileName: string;
  s3Key: string;
  fileSize: number;
  mimeType: string;
  deriveChecksum: boolean;
}

const registerObject = async (userId: string, input: RegisterObjectInput) => {
  if (!input.s3Key.startsWith(`${userId}/`)) {
    throw new ApiError(
      400,
      "Invalid s3Key: metadata must be registered by its owner",
    );
  }

  let head;
  try {
    head = await s3.send(
      new HeadObjectCommand({
        Bucket: env.AWS_S3_BUCKET_NAME,
        Key: input.s3Key,
      }),
    );
  } catch (error) {
    if (
      (error as { name?: string }).name === "NotFound" ||
      (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode === 404
    ) {
      throw new ApiError(
        400,
        "Object not found in storage: upload the file before registering metadata",
      );
    }
    throw error;
  }

  const actualSize = Number(head.ContentLength ?? 0);
  if (actualSize !== input.fileSize) {
    throw new ApiError(
      400,
      "Size mismatch: uploaded object size does not match the registered size",
    );
  }

  const etag = head.ETag?.replace(/^"(.*)"$/, "$1") ?? null;

  return prisma.$transaction(async (tx) => {
    const reserved = await tx.$executeRaw`
      UPDATE "User"
      SET "storageUsed" = "storageUsed" + ${input.fileSize}
      WHERE "id" = ${userId}
        AND "storageUsed" + ${input.fileSize} <= "storageLimit"
    `;

    if (reserved === 0) {
      throw new ApiError(413, "Storage quota exceeded");
    }

    return tx.file.create({
      data: {
        fileName: sanitizeFileName(input.fileName),
        s3Key: input.s3Key,
        fileSize: input.fileSize,
        mimeType: input.mimeType,
        etag,
        checksum: input.deriveChecksum ? etag : null,
        ownerId: userId,
      },
    });
  });
};

export const createFileMetadata = async (
  userId: string,
  input: CreateFileMetadataInput,
) =>
  registerObject(userId, {
    fileName: input.fileName,
    s3Key: input.s3Key,
    fileSize: input.fileSize,
    mimeType: input.mimeType,
    deriveChecksum: true,
  });

const getActiveMultipartRecord = async (userId: string, uploadId: string) => {
  const record = await prisma.multipartUpload.findUnique({
    where: { uploadId },
  });

  if (!record) {
    throw new ApiError(404, "Multipart upload not found");
  }

  if (record.ownerId !== userId) {
    throw new ApiError(403, "You do not have permission to manage this upload");
  }

  if (record.completedAt !== null || record.abortedAt !== null) {
    throw new ApiError(409, "Multipart upload is no longer active");
  }

  return record;
};

export const startMultipartUpload = async (
  userId: string,
  input: StartMultipartInput,
): Promise<StartMultipartResult> => {
  await assertQuotaAvailable(userId, input.fileSize);

  const safeFileName = sanitizeFileName(input.fileName);
  const s3Key = `${userId}/${crypto.randomUUID()}-${safeFileName}`;

  const partCount = Math.ceil(
    input.fileSize / FILE_LIMITS.MULTIPART_PART_SIZE_BYTES,
  );

  if (partCount > FILE_LIMITS.MULTIPART_MAX_PART_COUNT) {
    throw new ApiError(400, "File is too large for multipart upload");
  }

  const created = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: s3Key,
      ContentType: input.fileType,
    }),
  );

  const uploadId = created.UploadId;
  if (!uploadId) {
    throw new ApiError(500, "Storage did not return a multipart upload id");
  }

  await prisma.multipartUpload.create({
    data: {
      uploadId,
      s3Key,
      fileName: safeFileName,
      mimeType: input.fileType,
      fileSize: input.fileSize,
      partSize: FILE_LIMITS.MULTIPART_PART_SIZE_BYTES,
      partCount,
      ownerId: userId,
    },
  });

  return {
    uploadId,
    s3Key,
    partSize: FILE_LIMITS.MULTIPART_PART_SIZE_BYTES,
    partCount,
    fileName: safeFileName,
  };
};

export const getMultipartPartUrl = async (
  userId: string,
  input: MultipartPartUrlInput,
): Promise<MultipartPartUrlResult> => {
  const record = await getActiveMultipartRecord(userId, input.uploadId);

  if (record.s3Key !== input.s3Key) {
    throw new ApiError(400, "s3Key does not match the multipart upload");
  }

  if (input.partNumber < 1 || input.partNumber > record.partCount) {
    throw new ApiError(
      400,
      `partNumber must be between 1 and ${record.partCount}`,
    );
  }

  const command = new UploadPartCommand({
    Bucket: env.AWS_S3_BUCKET_NAME,
    Key: record.s3Key,
    UploadId: record.uploadId,
    PartNumber: input.partNumber,
  });

  const partUrl = await getSignedUrl(s3, command, {
    expiresIn: FILE_LIMITS.UPLOAD_URL_EXPIRATION_MS,
  });

  return {
    partUrl,
    uploadId: record.uploadId,
    s3Key: record.s3Key,
    partNumber: input.partNumber,
  };
};

export const completeMultipartUpload = async (
  userId: string,
  input: CompleteMultipartInput,
) => {
  const record = await getActiveMultipartRecord(userId, input.uploadId);

  if (record.s3Key !== input.s3Key) {
    throw new ApiError(400, "s3Key does not match the multipart upload");
  }

  const parts = [...input.parts].sort((a, b) => a.PartNumber - b.PartNumber);

  const received = parts.map((part) => part.PartNumber);
  const expected = Array.from(
    { length: record.partCount },
    (_, index) => index + 1,
  );

  if (
    parts.length !== record.partCount ||
    expected.some((partNumber, index) => partNumber !== received[index])
  ) {
    throw new ApiError(
      400,
      `All parts 1..${record.partCount} must be uploaded exactly once`,
    );
  }

  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: record.s3Key,
      UploadId: record.uploadId,
      MultipartUpload: { Parts: parts },
    }),
  );

  const file = await registerObject(userId, {
    fileName: record.fileName,
    s3Key: record.s3Key,
    fileSize: record.fileSize,
    mimeType: record.mimeType,
    deriveChecksum: false,
  });

  await prisma.multipartUpload.update({
    where: { id: record.id },
    data: { completedAt: new Date() },
  });

  return file;
};

export const abortMultipartUpload = async (
  userId: string,
  input: AbortMultipartInput,
): Promise<void> => {
  const record = await getActiveMultipartRecord(userId, input.uploadId);

  if (record.s3Key !== input.s3Key) {
    throw new ApiError(400, "s3Key does not match the multipart upload");
  }

  try {
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: env.AWS_S3_BUCKET_NAME,
        Key: record.s3Key,
        UploadId: record.uploadId,
      }),
    );
  } catch (error) {
    logger.warn(
      { error, uploadId: record.uploadId },
      "S3 abort reported an error; upload may already be gone",
    );
  }

  await prisma.multipartUpload.update({
    where: { id: record.id },
    data: { abortedAt: new Date() },
  });
};

export const listUserFiles = async (
  userId: string,
  params: ListFilesParams,
): Promise<ListFilesResult> => {
  const limit = Math.min(
    params.limit ?? FILE_LIMITS.DEFAULT_LIST_LIMIT,
    FILE_LIMITS.MAX_LIST_LIMIT,
  );
  const take = limit + 1;

  const files = await prisma.file.findMany({
    where: { ownerId: userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });

  const hasMore = files.length > limit;
  const page = hasMore ? files.slice(0, limit) : files;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  return { files: page, nextCursor };
};

const getOwnedFile = async (userId: string, fileId: string) => {
  const file = await prisma.file.findUnique({ where: { id: fileId } });
  if (!file) {
    throw new ApiError(404, "File not found");
  }
  if (file.ownerId !== userId) {
    throw new ApiError(403, "You do not have permission to access this file");
  }
  return file;
};

export const updateFileVisibility = async (
  userId: string,
  fileId: string,
  visibility: Visibility,
) => {
  const file = await getOwnedFile(userId, fileId);
  return prisma.file.update({
    where: { id: file.id },
    data: { visibility },
  });
};

export const deleteFile = async (userId: string, fileId: string) => {
  const file = await getOwnedFile(userId, fileId);

  await prisma.$transaction([
    prisma.file.delete({ where: { id: file.id } }),
    prisma.$executeRaw`
      UPDATE "User"
      SET "storageUsed" = GREATEST(0, "storageUsed" - ${file.fileSize})
      WHERE "id" = ${userId}
    `,
  ]);

  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: env.AWS_S3_BUCKET_NAME,
        Key: file.s3Key,
      }),
    );
  } catch (error) {
    logger.error(
      { error, s3Key: file.s3Key },
      "S3 object delete failed; will be cleaned up by the reconcile job",
    );
  }
};

export const getDownloadUrl = async (
  input: GetDownloadUrlInput,
): Promise<DownloadResult> => {
  const file = await prisma.file.findUnique({ where: { id: input.fileId } });
  if (!file) {
    throw new ApiError(404, "File not found");
  }

  const isOwner = input.userId !== undefined && file.ownerId === input.userId;
  const isPublic = file.visibility === "PUBLIC";

  if (!isOwner && !isPublic) {
    throw new ApiError(403, "You do not have access to this file");
  }

  const command = new GetObjectCommand({
    Bucket: env.AWS_S3_BUCKET_NAME,
    Key: file.s3Key,
  });

  const downloadUrl = await getSignedUrl(s3, command, {
    expiresIn: FILE_LIMITS.DOWNLOAD_URL_EXPIRATION_MS,
  });

  return {
    downloadUrl,
    fileName: file.fileName,
    fileSize: file.fileSize,
    mimeType: file.mimeType,
    visibility: file.visibility,
  };
};

export const getPublicShare = async (
  input: DownloadPublicInput,
): Promise<DownloadResult> => getDownloadUrl({ fileId: input.fileId });
