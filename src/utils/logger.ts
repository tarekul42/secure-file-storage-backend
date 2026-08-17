import { pino, type Logger } from "pino";
import { env } from "../config/env.js";

export const logger: Logger = pino({
  level:
    env.NODE_ENV === "test"
      ? "silent"
      : env.NODE_ENV === "production"
        ? "info"
        : "debug",
  ...(env.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        },
      }
    : {}),
});
