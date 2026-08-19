import { z } from "zod";
import { allowedContentTypes } from "../../config/env.js";
import { FILE_LIMITS } from "./file.constants.js";

const isAllowedContentType = (value: string): boolean =>
  allowedContentTypes.has(value.toLowerCase());

const NOT_ALLOWED_MESSAGE = "is not in the allowed content-type list";

export const requestUploadSchema = {
  body: z.object({
    fileName: z
      .string()
      .trim()
      .min(1, "fileName is required")
      .max(FILE_LIMITS.MAX_FILENAME_LENGTH, "fileName is too long"),
    fileType: z
      .string()
      .trim()
      .min(1, "fileType is required")
      .max(255, "fileType is too long")
      .refine(isAllowedContentType, `fileType ${NOT_ALLOWED_MESSAGE}`),
    fileSize: z
      .number()
      .int("fileSize must be an integer")
      .nonnegative("fileSize must be non-negative")
      .max(FILE_LIMITS.MAX_SIZE_BYTES, "File size exceeds the 100MB limit"),
  }),
};

export const createFileMetadataSchema = {
  body: z.object({
    fileName: z
      .string()
      .trim()
      .min(1, "fileName is required")
      .max(FILE_LIMITS.MAX_FILENAME_LENGTH, "fileName is too long"),
    s3Key: z.string().trim().min(1, "s3Key is required").max(2048),
    fileSize: z
      .number()
      .int("fileSize must be an integer")
      .nonnegative("fileSize must be non-negative")
      .max(FILE_LIMITS.MAX_SIZE_BYTES, "File size exceeds the 100MB limit"),
    mimeType: z
      .string()
      .trim()
      .min(1, "mimeType is required")
      .max(255)
      .refine(isAllowedContentType, `mimeType ${NOT_ALLOWED_MESSAGE}`),
  }),
};

const multipartUploadSchema = {
  body: z.object({
    uploadId: z.string().trim().min(1, "uploadId is required").max(1024),
    s3Key: z.string().trim().min(1, "s3Key is required").max(2048),
  }),
};

export const startMultipartUploadSchema = {
  body: z.object({
    fileName: z
      .string()
      .trim()
      .min(1, "fileName is required")
      .max(FILE_LIMITS.MAX_FILENAME_LENGTH, "fileName is too long"),
    fileType: z
      .string()
      .trim()
      .min(1, "fileType is required")
      .max(255, "fileType is too long")
      .refine(isAllowedContentType, `fileType ${NOT_ALLOWED_MESSAGE}`),
    fileSize: z
      .number()
      .int("fileSize must be an integer")
      .nonnegative("fileSize must be non-negative")
      .gt(
        FILE_LIMITS.MAX_SIZE_BYTES,
        "Use the single-PUT upload for files up to 100MB",
      )
      .max(
        FILE_LIMITS.MULTIPART_MAX_SIZE_BYTES,
        "File size exceeds the 5GB multipart limit",
      ),
  }),
};

export const multipartPartUrlSchema = {
  body: z.object({
    uploadId: z.string().trim().min(1, "uploadId is required").max(1024),
    s3Key: z.string().trim().min(1, "s3Key is required").max(2048),
    partNumber: z
      .number()
      .int("partNumber must be an integer")
      .min(1, "partNumber must be at least 1")
      .max(
        FILE_LIMITS.MULTIPART_MAX_PART_COUNT,
        `partNumber must be at most ${FILE_LIMITS.MULTIPART_MAX_PART_COUNT}`,
      ),
  }),
};

export const completeMultipartUploadSchema = {
  body: z.object({
    uploadId: z.string().trim().min(1, "uploadId is required").max(1024),
    s3Key: z.string().trim().min(1, "s3Key is required").max(2048),
    parts: z
      .array(
        z.object({
          PartNumber: z
            .number()
            .int("PartNumber must be an integer")
            .min(1, "PartNumber must be at least 1")
            .max(FILE_LIMITS.MULTIPART_MAX_PART_COUNT),
          ETag: z.string().trim().min(1, "ETag is required").max(2048),
        }),
      )
      .min(1, "parts must include at least one part"),
  }),
};

export const abortMultipartUploadSchema = multipartUploadSchema;

export const fileIdParamsSchema = {
  params: z.object({
    id: z.string().uuid("A valid file id is required"),
  }),
};

export const listFilesQuerySchema = {
  query: z.object({
    cursor: z.string().uuid("A valid cursor is required").optional(),
    limit: z.coerce
      .number("limit must be a number")
      .int("limit must be an integer")
      .min(1, "limit must be at least 1")
      .max(
        FILE_LIMITS.MAX_LIST_LIMIT,
        `limit must be at most ${FILE_LIMITS.MAX_LIST_LIMIT}`,
      )
      .optional(),
  }),
};

export const updateVisibilitySchema = {
  params: fileIdParamsSchema.params,
  body: z.object({
    visibility: z.enum(["PUBLIC", "PRIVATE"], {
      message: "visibility must be PUBLIC or PRIVATE",
    }),
  }),
};
