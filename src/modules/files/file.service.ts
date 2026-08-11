import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { ApiError } from "../../utils/errors.js";
import { FILE_LIMITS } from "./file.constants.js";
import type {
  CreateFileMetadataInput,
  DownloadResult,
  DownloadPublicInput,
  GetDownloadUrlInput,
  RequestUploadInput,
  RequestUploadResult,
  Visibility,
} from "./file.interfaces.js";

const s3Config: S3ClientConfig = {
  region: env.AWS_REGION,
};
if (env.S3_ENDPOINT) {
  s3Config.endpoint = env.S3_ENDPOINT;
  s3Config.forcePathStyle = env.AWS_FORCE_PATH_STYLE;
}
const s3 = new S3Client(s3Config);

const sanitizeFileName = (fileName: string): string =>
  fileName.replace(/[\\/]+/g, "_").slice(0, FILE_LIMITS.MAX_FILENAME_LENGTH);

export const requestUploadUrl = async (
  userId: string,
  input: RequestUploadInput,
): Promise<RequestUploadResult> => {
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

export const createFileMetadata = async (
  userId: string,
  input: CreateFileMetadataInput,
) => {
  if (!input.s3Key.startsWith(`${userId}/`)) {
    throw new ApiError(
      400,
      "Invalid s3Key: metadata must be registered by its owner",
    );
  }

  return prisma.file.create({
    data: {
      fileName: sanitizeFileName(input.fileName),
      s3Key: input.s3Key,
      fileSize: input.fileSize,
      mimeType: input.mimeType,
      ownerId: userId,
    },
  });
};

export const listUserFiles = async (userId: string) =>
  prisma.file.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: "desc" },
  });

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

  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: env.AWS_S3_BUCKET_NAME,
        Key: file.s3Key,
      }),
    );
  } catch (error) {
    console.error("Failed to delete S3 object, removing metadata only:", error);
  }

  await prisma.file.delete({ where: { id: file.id } });
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
): Promise<DownloadResult> =>
  getDownloadUrl({ fileId: input.fileId });