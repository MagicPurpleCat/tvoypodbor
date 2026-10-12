// Применяет migrations/*.sql по порядку, каждую в своей транзакции.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, tx } from './db.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
const applied = new Set(rows.map((r) => r.name));
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = await readFile(path.join(dir, file), 'utf8');
  await tx(async (c) => {
    await c.query(sql);
    await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  });
  console.log(`applied ${file}`);
}

await pool.end();
