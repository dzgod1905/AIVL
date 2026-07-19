import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  // Fail loudly at call sites rather than at import time in dev without a DB.
  console.warn("DATABASE_URL is not set - DB calls will fail until configured.");
}

// Fallback keeps a valid URL *shape* so neon() doesn't throw at import/build time
// when DATABASE_URL is unset; real queries still fail until it's configured.
const sql = neon(url ?? "postgresql://user:pass@localhost/db");
export const db = drizzle(sql, { schema });
export { schema };
