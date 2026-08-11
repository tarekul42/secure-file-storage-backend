import type { NextFunction, Request, Response } from "express";
import { ApiError, isApiError } from "../utils/errors.js";

export const notFoundHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (isApiError(err)) {
    res.status(err.statusCode).json({
      message: err.message,
      ...(err.details ? { errors: err.details } : {}),
    });
    return;
  }

  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ message: "Invalid JSON payload" });
    return;
  }

  console.error("Unexpected error:", err);
  res.status(500).json({ message: "Internal Server Error" });
};
