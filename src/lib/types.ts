export type Visibility = "PUBLIC" | "PRIVATE";

export interface AuthUser {
  id: string;
  email: string;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
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