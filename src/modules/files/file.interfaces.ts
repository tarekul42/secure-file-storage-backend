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
