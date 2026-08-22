import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import crypto from "node:crypto";
import { allowedOrigins, env } from "./config/env.js";
import {
  errorHandler,
  notFoundHandler,
} from "./middleware/error.middleware.js";
import { requestId, REQUEST_ID_HEADER } from "./middleware/request-id.js";
import authRoutes from "./modules/auth/auth.routes.js";
import fileRoutes from "./modules/files/file.routes.js";
import healthRoutes from "./modules/health/health.routes.js";
import { logger } from "./utils/logger.js";
import {
  requestSerializer,
  responseSerializer,
} from "./utils/log-serializers.js";

export const createApp = (): express.Express => {
  const app = express();

  app.set("trust proxy", 1);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = req.requestId ?? crypto.randomUUID();
        req.requestId = id;
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
      // Whitelist-only request/response serialization; see log-serializers.
      serializers: {
        req: requestSerializer,
        res: responseSerializer,
      },
      autoLogging: env.NODE_ENV !== "test",
    }),
  );

  app.use((helmet as unknown as () => express.RequestHandler)());
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.use("/health", healthRoutes);

  app.use("/api/auth", authRoutes);
  app.use("/api/files", fileRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
