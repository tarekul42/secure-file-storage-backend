import { z } from "zod";
import { FILE_LIMITS } from "./file.constants.js";

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
      .max(255, "fileType is too long"),
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
    mimeType: z.string().trim().min(1, "mimeType is required").max(255),
  }),
};

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
