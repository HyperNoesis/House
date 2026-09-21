// migrate.js — applies migrations/*.sql (in filename order) to the
// Postgres database at DATABASE_URL. Safe to re-run: applied migrations
// are tracked in schema_migrations and skipped on subsequent runs.
//
// Usage:  DATABASE_URL=postgres://... node src/migrate.js
// or:     npm run migrate

const fs = require("fs");
const path = require("path");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — nothing to migrate against.");
    process.exit(1);
  }

  const { Pool } = require("pg"); // npm install pg
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const dir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  const { rows: applied } = await pool.query("SELECT filename FROM schema_migrations");
  const appliedSet = new Set(applied.map((r) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    console.log(`apply ${file}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  console.log("Migrations up to date.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
