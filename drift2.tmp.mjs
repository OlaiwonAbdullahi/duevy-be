import { execSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import EmbeddedPostgres from 'embedded-postgres';
const dir = mkdtempSync(path.join(tmpdir(), 'duevy-drift2-'));
const port = 57_000 + Math.floor(Math.random() * 900);
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'd', password: 'd', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {} });
await pg.initialise(); await pg.start(); await pg.createDatabase('shadow');
try {
  const out = execSync(`npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://d:d@localhost:${port}/shadow --script`, { encoding: 'utf8' });
  console.log('DIFF START\n' + out + '\nDIFF END');
} finally { await pg.stop(); }
