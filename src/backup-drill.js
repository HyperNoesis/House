// backup-drill.js — "we have backups" means nothing until you've proven
// you can actually restore one. This script does the whole loop:
// take a fresh backup -> restore it into a SCRATCH location (never your
// live database) -> verify it -> report pass/fail with a non-zero exit
// code on failure, so this can be a scheduled job that pages you the
// moment a backup silently stops being restorable.
//
// Usage:  node src/backup-drill.js
// Env (Postgres only): DRILL_DATABASE_URL — a separate, disposable
//   Postgres database to restore into. Without it, the Postgres path
//   only validates the dump's structure (still catches "the dump is
//   empty/corrupt/missing a table"), not a true restore — set this for
//   a real drill.

const fs = require("fs");
const path = require("path");
const os = require("os");

async function drillSqlite() {
  const { DatabaseSync } = require("node:sqlite");
  const { backupSqlite, TABLES_PARENT_FIRST } = require("./backup");
  const { restoreSqlite } = require("./restore");

  const sourcePath = process.env.ILE_DB_PATH || path.join(__dirname, "..", "data", "ile.db");
  console.log(`1. Taking a fresh backup of ${sourcePath}...`);
  const { outPath } = await backupSqlite();
  console.log(`   -> ${outPath}`);

  const scratchPath = path.join(os.tmpdir(), `ile-drill-${Date.now()}.db`);
  console.log(`2. Restoring it into a scratch DB (never the live one): ${scratchPath}...`);
  await restoreSqlite(outPath, scratchPath);

  console.log("3. Verifying the restored copy...");
  const failures = [];

  const restored = new DatabaseSync(scratchPath);
  const integrity = restored.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") failures.push(`integrity_check reported: ${integrity.integrity_check}`);

  const source = new DatabaseSync(sourcePath);
  for (const table of TABLES_PARENT_FIRST) {
    const sourceCount = source.prepare(`SELECT COUNT(*) as n FROM ${table}`).get().n;
    const restoredCount = restored.prepare(`SELECT COUNT(*) as n FROM ${table}`).get().n;
    if (sourceCount !== restoredCount) failures.push(`${table}: source has ${sourceCount} rows, restored copy has ${restoredCount}`);
    else console.log(`   ${table}: ${restoredCount} rows match`);
  }
  restored.close();
  source.close();
  fs.unlinkSync(scratchPath);

  return failures;
}

async function drillPostgres() {
  const { backupPostgres, TABLES_PARENT_FIRST } = require("./backup");
  console.log("1. Taking a fresh backup (JSON table dump)...");
  const { outPath } = await backupPostgres();
  console.log(`   -> ${outPath}`);

  const dump = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const failures = [];

  if (!process.env.DRILL_DATABASE_URL) {
    console.log("2. DRILL_DATABASE_URL not set — skipping a real restore.");
    console.log("   Validating dump structure only (weaker check — set DRILL_DATABASE_URL for a real drill).");
    for (const table of TABLES_PARENT_FIRST) {
      if (!Array.isArray(dump.tables[table])) failures.push(`${table}: missing from dump`);
      else console.log(`   ${table}: ${dump.tables[table].length} rows present in dump`);
    }
    return failures;
  }

  console.log(`2. Restoring into scratch database (DRILL_DATABASE_URL)...`);
  const { restorePostgres } = require("./restore");
  await restorePostgres(outPath, process.env.DRILL_DATABASE_URL);

  console.log("3. Verifying row counts against the scratch database...");
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DRILL_DATABASE_URL, ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false } });
  for (const table of TABLES_PARENT_FIRST) {
    const expected = dump.tables[table].length;
    const { rows } = await pool.query(`SELECT COUNT(*) as n FROM ${table}`);
    const actual = Number(rows[0].n);
    if (actual !== expected) failures.push(`${table}: dump has ${expected} rows, restored scratch DB has ${actual}`);
    else console.log(`   ${table}: ${actual} rows match`);
  }
  await pool.end();
  return failures;
}

async function main() {
  const usingPostgres = !!process.env.DATABASE_URL;
  console.log(`Running restore drill (${usingPostgres ? "Postgres" : "SQLite"})...\n`);
  const failures = usingPostgres ? await drillPostgres() : await drillSqlite();

  console.log("");
  if (failures.length) {
    console.error(`DRILL FAILED (${failures.length} issue${failures.length > 1 ? "s" : ""}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("DRILL PASSED — the most recent backup is restorable and complete.");
}

main().catch((err) => {
  console.error("Drill crashed (treat this as a failure too):", err.message);
  process.exit(1);
});
