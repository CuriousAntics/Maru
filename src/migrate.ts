 import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { required } from './config.js';

async function migrate(): Promise<void> {
  const client = new pg.Client({
    connectionString: required('DATABASE_URL'),
    connectionTimeoutMillis: 10000,
  });
  let locked = false;

  try {
    await client.connect();

    // One session owns the lock for the entire migration run.
    await client.query('SELECT pg_advisory_lock(731204, 1)');
    locked = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const directory = new URL('../migrations/', import.meta.url);
    const files = (await readdir(directory))
      .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
      .sort();

    if (files.length === 0) throw new Error('NO_MIGRATION_FILES');
   const history = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name'
    );

    // Applied history must be an unchanged prefix of the current files.
    for (let i = 0; i < history.rows.length; i++) {
      if (history.rows[i]?.name !== files[i]) {
        throw new Error('MIGRATION_HISTORY_MISMATCH');
      }
    }

    // Validate all files before applying any new migration.
    const pending: { name: string; sql: string; checksum: string }[] = [];
    const numbers = new Set<string>();
    for (const [index, name] of files.entries()) {
      const number = name.slice(0, 3);
      if (numbers.has(number)) throw new Error('DUPLICATE_MIGRATION_NUMBER');
      numbers.add(number);

      // Normalize Windows line endings and an optional editor BOM.
      const sql = (await readFile(new URL(name, directory), 'utf8'))
        .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const applied = history.rows[index];
      if (applied) {
        if (applied.checksum !== checksum) {
          throw new Error('APPLIED_MIGRATION_CHANGED');
        }
      } else {
        pending.push({ name, sql, checksum });
      }
    }

    for (const migration of pending) {
      console.log(`Applying ${migration.name}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [migration.name, migration.checksum]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      console.log(`Applied ${migration.name}`);
    }
    console.log(pending.length ? 'Migrations complete.' : 'Database is up to date.');
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(731204, 1)');
    } finally {
      await client.end();
    }
  }
}

migrate().catch((error: unknown) => {
  const raw = error && typeof error === 'object' && 'code' in error
    ? String(error.code) : error instanceof Error ? error.message : 'UNKNOWN';
  const code = /^[A-Z0-9_]+$/.test(raw) ? raw : 'CHECK_CONFIGURATION';
  console.error(`Migration failed: ${code}`);
  process.exitCode = 1;
});
