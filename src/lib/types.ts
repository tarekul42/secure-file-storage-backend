export type Visibility = "PUBLIC" | "PRIVATE";

export interface AuthUser {
  id: string;
  email: string;
  role: "USER" | "ADMIN";
  isVerified: boolean;
  storageUsed: number;
  storageLimit: number;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  refreshToken: string;
  user: AuthUser;
}

export interface RefreshTokenResponse {
  token: string;
  refreshToken: string;
}

export interface FileItem {
  id: string;
  fileName: string;
  s3Key: string;
  fileSize: number;
  mimeType: string;
  visibility: Visibility;
  ownerId: string;
  createdAt: string;
}

export interface FileListResponse {
  files: FileItem[];
  nextCursor: string | null;
}

export interface DownloadResponse {
  downloadUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  visibility: Visibility;
}

export interface ApiErrorField {
  path: string;
  message: string;
}

export interface ApiErrorResponse {
  message: string;
  errors?: ApiErrorField[];
}

export interface RequestUploadResponse {
  uploadUrl: string;
  s3Key: string;
  fileName: string;
}

export interface MultipartStartResponse {
  uploadId: string;
  s3Key: string;
  partSize: number;
  partCount: number;
  fileName: string;
}

export interface MultipartPartUrlResponse {
  partUrl: string;
  uploadId: string;
  s3Key: string;
  partNumber: number;
}

export interface MultipartPart {
  PartNumber: number;
  ETag: string;
}
