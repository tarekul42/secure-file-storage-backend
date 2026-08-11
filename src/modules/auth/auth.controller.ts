import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/async-handler.js";
import type { AuthenticatedRequest } from "../../middleware/types.js";
import {
  getUserById,
  loginUser,
  registerUser,
} from "./auth.service.js";

export const register = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await registerUser({
      email: req.body.email,
      password: req.body.password,
    });
    res.status(201).json(result);
  },
);

export const login = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await loginUser({
      email: req.body.email,
      password: req.body.password,
    });
    res.json(result);
  },
);

export const me = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const user = await getUserById(req.userId as string);
    res.json({ user });
  },
);