import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const REQUEST_ID_HEADER = "X-Request-Id";

/* eslint-disable @typescript-eslint/no-namespace -- Express type augmentation */
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export const requestId = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const incoming = req.headers[REQUEST_ID_HEADER.toLowerCase()];
  const id =
    (Array.isArray(incoming) ? incoming[0] : incoming) ?? crypto.randomUUID();
  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};
