import type { ZodType } from "zod";
import type { NextFunction, Request, Response } from "express";
import { ApiError, type ApiErrorDetail } from "../utils/errors.js";

interface ValidationParts {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

interface PartResult<T extends object> {
  data?: T;
  issues?: ApiErrorDetail[];
}

const parsePart = <T extends object>(
  schema: ZodType,
  value: unknown,
): PartResult<T> => {
  const result = schema.safeParse(value);
  if (result.success) {
    return { data: result.data as T };
  }
  return {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
};

export const validate =
  (parts: ValidationParts) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const errors: ApiErrorDetail[] = [];

    if (parts.body) {
      const { data, issues } = parsePart(parts.body, req.body);
      if (issues) errors.push(...issues);
      else req.body = data;
    }

    if (parts.query) {
      const { data, issues } = parsePart(parts.query, req.query);
      if (issues) errors.push(...issues);
      else req.query = data as Request["query"];
    }

    if (parts.params) {
      const { data, issues } = parsePart(parts.params, req.params);
      if (issues) errors.push(...issues);
      else req.params = data as Request["params"];
    }

    if (errors.length > 0) {
      next(new ApiError(400, "Validation failed", errors));
      return;
    }

    next();
  };