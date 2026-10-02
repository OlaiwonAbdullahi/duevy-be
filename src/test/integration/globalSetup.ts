import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Boots a throwaway Postgres for the integration suite and applies the real
 * migration chain to it (prisma migrate deploy), so the tests also prove the
 * migrations apply cleanly from the baseline.
 *
 * Set TEST_DATABASE_URL to use an existing empty database instead (CI).
 * Never points at the DATABASE_URL in .env.
 */
let pg: EmbeddedPostgres | null = null;
let dataDir: string | null = null;

export async function setup(): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const port = 54_000 + Math.floor(Math.random() * 900);
    dataDir = mkdtempSync(path.join(tmpdir(), 'duevy-pg-'));
    pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'duevy', password: 'duevy', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {} });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('duevy_test');
    url = `postgresql://duevy:duevy@localhost:${port}/duevy_test`;
  }
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;

  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}

export async function teardown(): Promise<void> {
  if (pg) await pg.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
