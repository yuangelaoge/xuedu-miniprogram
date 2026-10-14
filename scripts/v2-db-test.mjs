import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// Disposable local Docker database only. No connection string or cloud credential accepted.
const pagesOnly = process.argv.includes('--pages');
const scheduling = process.argv.includes('--scheduling');
const officer = process.argv.includes('--officer') || scheduling;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const container = 'xuedu-v2-test-' + process.pid;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
let started = false;
try {
  docker(['info', '--format', '{{.ServerVersion}}']);
  docker(['run', '-d', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17']); started = true;
  for (let i = 0; i < 60; i++) {
    try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  const sql = `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',''); $$;
    GRANT USAGE ON SCHEMA auth TO PUBLIC; GRANT EXECUTE ON FUNCTION auth.role() TO PUBLIC;`;
  execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: sql, stdio: ['pipe','ignore','inherit'] });
  execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: readFileSync(resolve(root,'server/migrations/003-v2-resources.sql')), stdio:['pipe','ignore','inherit'] });
  execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: readFileSync(resolve(root,'server/migrations/004-auto-approval.sql')), stdio:['pipe','ignore','inherit'] });
  if (officer) execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: readFileSync(resolve(root,'server/migrations/005-review-sandbox.sql')), stdio:['pipe','ignore','inherit'] });
  if (pagesOnly || officer) execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: readFileSync(resolve(root,'server/migrations/006-page-bootstrap.sql')), stdio:['pipe','ignore','inherit'] });
  if (officer) execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: readFileSync(resolve(root,'server/migrations/007-information-officer.sql')), stdio:['pipe','ignore','inherit'] });
  if (pagesOnly || officer) execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: readFileSync(resolve(root,'server/migrations/008-officer-record-access.sql')), stdio:['pipe','ignore','inherit'] });
  if (pagesOnly || officer) execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: readFileSync(resolve(root,'server/migrations/009-scheduling-read.sql')), stdio:['pipe','ignore','inherit'] });
  const result = spawnSync(process.execPath, ['--import','tsx','--test',scheduling ? 'tests/v2-scheduling-rpc.test.ts' : pagesOnly ? 'tests/v2-page-rpc.test.ts' : 'tests/v2-database-postgres.test.ts'], { cwd:root, env:{...process.env,XUEDU_LOCAL_PG_CONTAINER:container},stdio:'inherit' });
  process.exitCode = result.status === 0 ? 0 : 1;
} catch (e) { console.error('Local PostgreSQL test failed:', e.message); process.exitCode=1; }
finally { if(started) docker(['rm','-f',container]); }
