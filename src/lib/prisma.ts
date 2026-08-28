import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

function createAdapter(connectionString: string) {
  const hostname = new URL(connectionString).hostname;

  if (hostname.endsWith(".neon.tech")) {
    return new PrismaNeon({
      connectionString,
    });
  }

  return new PrismaPg({
    connectionString,
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: createAdapter(databaseUrl),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}