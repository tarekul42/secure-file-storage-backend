import type { IncomingMessage, ServerResponse } from "node:http";
import { sanitizeUrlForLog } from "./log-sanitize.js";

// Whitelist-only request/response serialization for pino-http. Its default
// serializer emits request headers (including Authorization), which would leak
// bearer tokens into logs.
export const requestSerializer = (
  req: IncomingMessage & { requestId?: string },
): Record<string, unknown> => ({
  id: req.id,
  requestId: req.requestId,
  method: req.method,
  // Query strings can carry presigned-URL signatures; log paths only.
  url: sanitizeUrlForLog(req.url),
});

export const responseSerializer = (
  res: ServerResponse & { request?: { requestId?: string } },
): Record<string, unknown> => ({
  statusCode: res.statusCode,
  requestId: res.request?.requestId,
});
