import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./db/prisma.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`🚀 Server running on port ${env.PORT}`);
});

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal} received, shutting down gracefully...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));