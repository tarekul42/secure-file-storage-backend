import { Router } from "express";
import { authenticate } from "../../middleware/auth.middleware.js";
import { validate } from "../../middleware/validate.middleware.js";
import {
  createMetadata,
  downloadFile,
  listFiles,
  removeFile,
  requestUpload,
  shareFile,
  updateVisibility,
} from "./file.controller.js";
import {
  createFileMetadataSchema,
  fileIdParamsSchema,
  requestUploadSchema,
  updateVisibilitySchema,
} from "./file.validation.js";

const router = Router();

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

router.get("/", authenticate, listFiles);

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