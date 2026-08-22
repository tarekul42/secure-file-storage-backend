import { pino, type Logger } from "pino";
import { env } from "../config/env.js";

// Defense in depth: even though the pino-http request serializer in app.ts
// whitelists fields, these redact paths guarantee credential-bearing values
// never reach a log line if some code path attaches headers/cookies to the
// loggable object.
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.set-cookie",
  "authorization",
  "cookie",
  "refreshToken",
  "password",
];

export const logger: Logger = pino({
  level:
    env.NODE_ENV === "test"
      ? "silent"
      : env.NODE_ENV === "production"
        ? "info"
        : "debug",
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
  },
  ...(env.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        },
      }
    : {}),
});
