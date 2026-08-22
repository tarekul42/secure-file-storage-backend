import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";
import { env } from "./config/env.js";

const DEMO_EMAIL = "demo@example.com";
const DEMO_PASSWORD = "password123";
const BCRYPT_SALT_ROUNDS = 10;

// The seed creates an account with well-known public credentials. It must
// never run against a production database unless explicitly forced.
if (env.NODE_ENV === "production" && !process.argv.includes("--force")) {
  console.error(
    "Refusing to seed: NODE_ENV is production and the seed creates a" +
      " publicly-known demo account. Pass --force to override.",
  );
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const hashedPassword = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_SALT_ROUNDS);

const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });

if (existing) {
  await prisma.user.update({
    where: { email: DEMO_EMAIL },
    data: { password: hashedPassword },
  });
  console.log(
    `Demo user already exists; password synced to "${DEMO_PASSWORD}"`,
  );
} else {
  await prisma.user.create({
    data: { email: DEMO_EMAIL, password: hashedPassword },
  });
  console.log(`Demo user created: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

await prisma.$disconnect();
