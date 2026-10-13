import pg from 'pg';
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(new URL('../.runtime/local.json', import.meta.url), 'utf8'));
const c = new pg.Client({ host: '127.0.0.1', port: config.port, user: 'seatraces', password: config.password, database: 'seatraces' });
await c.connect();
try {
  const conflicts = (await c.query('SELECT count(*)::int n FROM (SELECT lower(username) FROM users GROUP BY lower(username) HAVING count(*)>1) x')).rows[0].n;
  if (conflicts) throw Error('Case-insensitive usernames conflict; review before migration. No records changed.');
  await c.query('BEGIN');
  // Snapshot only in PostgreSQL, never export account data to JSON files.
  await c.query('CREATE SCHEMA IF NOT EXISTS account_before_20261013');
  await c.query('CREATE TABLE IF NOT EXISTS account_before_20261013.users AS TABLE public.users');
  await c.query('CREATE TABLE IF NOT EXISTS account_before_20261013.sessions AS TABLE public.sessions');
  await c.query('COMMIT');
  const version = (await c.query('SHOW server_version')).rows[0].server_version;
  console.log(JSON.stringify({ database: 'PostgreSQL', version, backup: 'account_before_20261013', caseConflicts: conflicts, userDataExported: false }));
} finally { await c.end(); }
