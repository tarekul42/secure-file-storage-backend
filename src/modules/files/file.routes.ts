import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware.js";
import { validate } from "../../middleware/validate.middleware.js";
import {
  abortMultipart,
  completeMultipart,
  createMetadata,
  downloadFile,
  listFiles,
  partUrl,
  removeFile,
  requestUpload,
  shareFile,
  startMultipart,
  updateVisibility,
} from "./file.controller.js";
import {
  abortMultipartUploadSchema,
  completeMultipartUploadSchema,
  createFileMetadataSchema,
  fileIdParamsSchema,
  listFilesQuerySchema,
  multipartPartUrlSchema,
  requestUploadSchema,
  startMultipartUploadSchema,
  updateVisibilitySchema,
} from "./file.validation.js";

const router = Router();

router.post(
  "/multipart/start",
  authenticate,
  validate(startMultipartUploadSchema),
  startMultipart,
);

router.post(
  "/multipart/part-url",
  authenticate,
  validate(multipartPartUrlSchema),
  partUrl,
);

router.post(
  "/multipart/complete",
  authenticate,
  validate(completeMultipartUploadSchema),
  completeMultipart,
);

router.post(
  "/multipart/abort",
  authenticate,
  validate(abortMultipartUploadSchema),
  abortMultipart,
);

router.post(
  "/upload-url",
  authenticate,
  validate(requestUploadSchema),
  requestUpload,
);

router.post(
  "/",
  authenticate,
  validate(createFileMetadataSchema),
  createMetadata,
);

router.get("/", authenticate, validate(listFilesQuerySchema), listFiles);

router.patch(
  "/:id",
  authenticate,
  validate(updateVisibilitySchema),
  updateVisibility,
);

router.delete("/:id", authenticate, validate(fileIdParamsSchema), removeFile);

router.get(
  "/:id/download",
  authenticate,
  validate(fileIdParamsSchema),
  downloadFile,
);

router.get("/:id/share", validate(fileIdParamsSchema), shareFile);

export default router;
