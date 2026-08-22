import type { NextFunction, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { ApiError } from "../utils/errors.js";
import { TOKEN_PREFIX, type AuthenticatedRequest } from "./types.js";

interface JwtPayload {
  id: string;
  email: string;
  tokenVersion?: number;
}

export const authenticate = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith(TOKEN_PREFIX)) {
      next(new ApiError(401, "Unauthorized: missing bearer token"));
      return;
    }

    const token = header.slice(TOKEN_PREFIX.length);

    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { tokenVersion: true },
    });

    if (!user) {
      next(new ApiError(401, "Unauthorized: account no longer exists"));
      return;
    }

    if (user.tokenVersion !== (payload.tokenVersion ?? 0)) {
      next(
        new ApiError(
          401,
          "Unauthorized: token was invalidated. Please log in again",
        ),
      );
      return;
    }

    req.userId = payload.id;
    next();
  } catch {
    next(new ApiError(401, "Unauthorized: invalid or expired token"));
  }
};
