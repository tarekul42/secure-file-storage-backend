import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middleware/types.js";
import { asyncHandler } from "../../utils/async-handler.js";
import type { Visibility } from "./file.interfaces.js";
import {
  createFileMetadata,
  deleteFile,
  getDownloadUrl,
  getPublicShare,
  listUserFiles,
  requestUploadUrl,
  updateFileVisibility,
} from "./file.service.js";

const userIdOf = (req: AuthenticatedRequest): string => req.userId as string;

const fileIdOf = (req: AuthenticatedRequest | Request): string =>
  req.params.id as string;

export const requestUpload = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await requestUploadUrl(userIdOf(req), req.body);
    res.json(result);
  },
);

export const createMetadata = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const file = await createFileMetadata(userIdOf(req), req.body);
    res.status(201).json(file);
  },
);

export const listFiles = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const files = await listUserFiles(userIdOf(req));
    res.json(files);
  },
);

export const updateVisibility = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const file = await updateFileVisibility(
      userIdOf(req),
      fileIdOf(req),
      req.body.visibility as Visibility,
    );
    res.json(file);
  },
);

export const removeFile = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await deleteFile(userIdOf(req), fileIdOf(req));
    res.status(204).send();
  },
);

export const downloadFile = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await getDownloadUrl({
      fileId: fileIdOf(req),
      userId: userIdOf(req),
    });
    res.json(result);
  },
);

export const shareFile = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await getPublicShare({ fileId: fileIdOf(req) });
    res.json(result);
  },
);