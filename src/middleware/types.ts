import type { NextFunction, Request } from "express";

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

export const TOKEN_TYPE = "Bearer";
export const TOKEN_PREFIX = `${TOKEN_TYPE} `;