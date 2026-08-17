import { PrismaPg } from "@prisma/adapter-pg";
import { beforeAll } from "vitest";
import { PrismaClient } from "../src/generated/client.js";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL as string,
});
const prisma = new PrismaClient({ adapter });

const truncateAll = async (): Promise<void> => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE');
};

beforeAll(async () => {
  await truncateAll();
});
