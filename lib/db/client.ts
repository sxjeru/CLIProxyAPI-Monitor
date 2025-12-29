import { drizzle } from "drizzle-orm/vercel-postgres";
import { createPool } from "@vercel/postgres";

const pool = createPool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL
});

export const db = drizzle(pool);
