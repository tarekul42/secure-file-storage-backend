import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { authenticate } from "../../middleware/auth.middleware.js";
import { validate } from "../../middleware/validate.middleware.js";
import {
  forgotPassword,
  login,
  logout,
  logoutAll,
  me,
  refresh,
  register,
  resetPassword,
} from "./auth.controller.js";
import {
  forgotPasswordSchema,
  loginSchema,
  refreshTokenSchema,
  registerSchema,
  resetPasswordSchema,
} from "./auth.validation.js";

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many authentication attempts, please try again later",
});

router.post("/register", authLimiter, validate(registerSchema), register);
router.post("/login", authLimiter, validate(loginSchema), login);
router.post("/forgot-password", validate(forgotPasswordSchema), forgotPassword);
router.post("/reset-password", validate(resetPasswordSchema), resetPassword);
router.post("/refresh", authLimiter, validate(refreshTokenSchema), refresh);
router.post("/logout", validate(refreshTokenSchema), logout);
router.post("/logout-all", authenticate, logoutAll);
router.get("/me", authenticate, me);

export default router;
