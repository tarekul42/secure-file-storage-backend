export interface ApiErrorDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly details?: ApiErrorDetail[];

  constructor(statusCode: number, message: string, details?: ApiErrorDetail[]) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    if (details) {
      this.details = details;
    }
  }
}

export const isApiError = (error: unknown): error is ApiError =>
  error instanceof ApiError;
