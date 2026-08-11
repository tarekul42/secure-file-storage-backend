import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { authenticate } from "../../middleware/auth.middleware.js";
import { validate } from "../../middleware/validate.middleware.js";
import { login, me, register } from "./auth.controller.js";
import { loginSchema, registerSchema } from "./auth.validation.js";

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
router.get("/me", authenticate, me);

export default router;