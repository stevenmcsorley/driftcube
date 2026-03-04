import { Pool } from "pg";

export function createPool(): Pool {
  return new Pool({
    connectionString: process.env.PG_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/driftcube",
  });
}

