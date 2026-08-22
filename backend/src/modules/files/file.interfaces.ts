export type Visibility = "PUBLIC" | "PRIVATE";

export interface RequestUploadInput {
  fileName: string;
  fileType: string;
  fileSize: number;
}

export interface RequestUploadResult {
  uploadUrl: string;
  s3Key: string;
  fileName: string;
}

export interface CreateFileMetadataInput {
  fileName: string;
  s3Key: string;
  fileSize: number;
  mimeType: string;
}

export interface DownloadResult {
  downloadUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  visibility: Visibility;
}

export interface DownloadPublicInput {
  fileId: string;
}

export interface DownloadAuthenticatedInput {
  fileId: string;
  userId: string;
}

export interface GetDownloadUrlInput {
  fileId: string;
  userId?: string;
}

export interface ListFilesParams {
  cursor?: string;
  limit?: number;
}

export interface ListFilesResult {
  files: FileItem[];
  nextCursor?: string | null;
}

export interface StartMultipartInput {
  fileName: string;
  fileType: string;
  fileSize: number;
}

export interface StartMultipartResult {
  uploadId: string;
  s3Key: string;
  partSize: number;
  partCount: number;
  fileName: string;
}

export interface MultipartPartUrlInput {
  uploadId: string;
  s3Key: string;
  partNumber: number;
}

export interface MultipartPartUrlResult {
  partUrl: string;
  uploadId: string;
  s3Key: string;
  partNumber: number;
}

export interface MultipartPart {
  PartNumber: number;
  ETag: string;
}

export interface CompleteMultipartInput {
  uploadId: string;
  s3Key: string;
  parts: MultipartPart[];
}

export interface AbortMultipartInput {
  uploadId: string;
  s3Key: string;
}

export interface FileItem {
  id: string;
  fileName: string;
  s3Key: string;
  fileSize: number;
  mimeType: string;
  visibility: Visibility;
  ownerId: string;
  createdAt: Date;
}
