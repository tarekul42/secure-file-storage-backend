import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client.js";
import { env } from "../config/env.js";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });