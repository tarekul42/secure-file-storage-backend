import type { NextFunction, Request, Response } from "express";
import { ApiError, isApiError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export const notFoundHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const meta = {
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl,
  };

  if (isApiError(err)) {
    if (err.statusCode >= 500) {
      logger.error({ error: err, ...meta }, err.message);
    } else {
      logger.warn({ error: err, ...meta }, err.message);
    }
    res.status(err.statusCode).json({
      message: err.message,
      ...(err.details ? { errors: err.details } : {}),
    });
    return;
  }

  if (err instanceof SyntaxError && "body" in err) {
    logger.warn({ error: err, ...meta }, "Invalid JSON payload");
    res.status(400).json({ message: "Invalid JSON payload" });
    return;
  }

  logger.error({ error: err, ...meta }, "Unexpected error");
  res.status(500).json({ message: "Internal Server Error" });
};
