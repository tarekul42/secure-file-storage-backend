import type { NextFunction, Request, Response } from "express";
import { ApiError, isApiError } from "../utils/errors.js";
import { sanitizeUrlForLog } from "../utils/log-sanitize.js";
import { logger } from "../utils/logger.js";

export const notFoundHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

// Unexpected (non-ApiError) values can be arbitrary driver/infra errors whose
// properties may embed connection strings or other internals; log only the
// identity of the error. Stack traces stay in dev for debuggability.
const toLoggableError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    const loggable: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (process.env.NODE_ENV !== "production") {
      loggable.stack = error.stack;
    }
    return loggable;
  }
  return { name: typeof error, message: String(error) };
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
    // Query strings can carry presigned-URL signatures; log paths only.
    url: sanitizeUrlForLog(req.originalUrl),
  };

  if (isApiError(err)) {
    if (err.statusCode >= 500) {
      logger.error({ error: toLoggableError(err), ...meta }, err.message);
    } else {
      logger.warn({ error: toLoggableError(err), ...meta }, err.message);
    }
    res.status(err.statusCode).json({
      message: err.message,
      ...(err.details ? { errors: err.details } : {}),
    });
    return;
  }

  if (err instanceof SyntaxError && "body" in err) {
    logger.warn(
      { error: toLoggableError(err), ...meta },
      "Invalid JSON payload",
    );
    res.status(400).json({ message: "Invalid JSON payload" });
    return;
  }

  logger.error({ error: toLoggableError(err), ...meta }, "Unexpected error");
  res.status(500).json({ message: "Internal Server Error" });
};
