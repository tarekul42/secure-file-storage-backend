import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/async-handler.js";
import { checkReadiness } from "./health.service.js";

export const liveness = (_req: Request, res: Response): void => {
  res.json({ status: "ok", uptime: process.uptime() });
};

export const readiness = asyncHandler(
  async (_req: Request, res: Response): Promise<void> => {
    const result = await checkReadiness();
    res.status(result.status === "ok" ? 200 : 503).json(result);
  },
);
