import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middleware/types.js";
import { asyncHandler } from "../../utils/async-handler.js";
import {
  forgotPassword,
  getUserById,
  loginUser,
  refreshAccessToken,
  registerUser,
  resetPassword,
  revokeAllUserTokens,
  revokeRefreshToken,
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

export const forgotPassword = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    await forgotPassword(req.body);
    res.status(200).json({
      message: "If that account exists, a reset link has been sent.",
    });
  },
);

export const refresh = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await refreshAccessToken(req.body.refreshToken);
    res.json(result);
  },
);

export const resetPassword = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    await resetPassword(req.body);
    res.status(200).json({ message: "Password reset successfully" });
  },
);

export const logout = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    await revokeRefreshToken(req.body.refreshToken);
    res.status(204).send();
  },
);

export const logoutAll = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await revokeAllUserTokens(req.userId as string);
    res.status(204).send();
  },
);
