import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/async-handler.js";
import { checkReadiness } from "./health.service.js";

export const liveness = (_req: Request, res: Response): void => {
  // Deliberately minimal: no runtime detail (uptime, versions) that aids fingerprinting.
  res.json({ status: "ok" });
};

export const readiness = asyncHandler(
  async (_req: Request, res: Response): Promise<void> => {
    const result = await checkReadiness();
    res.status(result.status === "ok" ? 200 : 503).json(result);
  },
);
