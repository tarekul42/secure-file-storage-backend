import type { NextFunction, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { ApiError } from "../utils/errors.js";
import { TOKEN_PREFIX, type AuthenticatedRequest } from "./types.js";

interface JwtPayload {
  id: string;
  email: string;
}

export const authenticate = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith(TOKEN_PREFIX)) {
    next(new ApiError(401, "Unauthorized: missing bearer token"));
    return;
  }

  const token = header.slice(TOKEN_PREFIX.length);

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    req.userId = payload.id;
    next();
  } catch {
    next(new ApiError(401, "Unauthorized: invalid or expired token"));
  }
};
