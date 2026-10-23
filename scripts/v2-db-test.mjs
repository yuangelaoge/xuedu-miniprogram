import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Disposable local Docker database only. No connection string or cloud credential accepted.
export const PG_SUITES = Object.freeze({
  database: 'tests/v2-database-postgres.test.ts',
  pages: 'tests/v2-page-rpc.test.ts',
  scheduling: 'tests/v2-scheduling-rpc.test.ts',
  records: 'tests/v2-record-rpc.test.ts',
  options: 'tests/v2-course-options-pg.test.ts',
  'page-scope': 'tests/v2-page-task-scope-pg.test.ts',
  capacity: 'tests/v2-capacity-pg.test.ts',
  flow: 'tests/v2-release-flow-pg.test.ts',
});
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function migrationFiles(projectRoot = root) {
  return readdirSync(resolve(projectRoot, 'server/migrations')).filter(name => /^\d{3}-.+\.sql$/.test(name) && Number(name.slice(0, 3)) >= 3).sort();
}
export function selectSuites(args) {
  if (args.length === 0 || args[0] === '--officer' && args.length === 1) return ['database'];
  if (args.length === 1 && args[0] === '--all') return Object.keys(PG_SUITES);
  const selected = args.map(arg => arg.startsWith('--') ? arg.slice(2) : '');
  if (!selected.length || selected.some(name => !Object.hasOwn(PG_SUITES, name))) throw new Error('Use --all, --pages, --scheduling, --records, --options, --page-scope, --capacity or --flow.');
  return [...new Set(selected)];
}
export function tapCounts(output) {
  const last = label => Number([...output.matchAll(new RegExp('^# ' + label + ' (\\d+)$', 'gm'))].at(-1)?.[1] ?? -1);
  return {tests: last('tests'), passed: last('pass'), failed: last('fail'), skipped: last('skipped'), cancelled: last('cancelled')};
}

export async function runPgSuites(args = process.argv.slice(2)) {
  const selected = selectSuites(args);
  const migrations = migrationFiles();
  const container = 'xuedu-v2-test-' + process.pid;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psql = sql => execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: sql, stdio: ['pipe', 'ignore', 'inherit'] });
  let started = false;
  const results = [];
  try {
    docker(['info', '--format', '{{.ServerVersion}}']);
    // Never download an unreviewed dependency while running a release check.
    docker(['image', 'inspect', 'postgres:17', '--format', '{{.Id}}']);
    docker(['run', '--pull=never', '-d', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17']);
    started = true;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch (error) { if (i === 59) throw new Error('Local PostgreSQL did not become ready: ' + error.message); await new Promise(r => setTimeout(r, 500)); }
    }
    if (!ready) throw new Error('Local PostgreSQL did not become ready.');
    psql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    for (const [index, name] of selected.entries()) {
      // Suites intentionally have independent fixtures, migration replay and cutover tests.
      // Recreate only the database inside this newly created, disposable container.
      if (index > 0) {
        docker(['exec', container, 'dropdb', '-U', 'postgres', '--force', 'postgres']);
        docker(['exec', container, 'createdb', '-U', 'postgres', 'postgres']);
      }
      psql(`CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',''); $$;
        GRANT USAGE ON SCHEMA auth TO PUBLIC; GRANT EXECUTE ON FUNCTION auth.role() TO PUBLIC;`);
      for (const file of migrations) psql(readFileSync(resolve(root, 'server/migrations', file)));
      console.log(`Local PostgreSQL suite: ${name}; migrations: ${migrations.join(', ')}`);
      const startedAt = Date.now();
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', PG_SUITES[name]], {
        cwd: root, env: {...process.env, XUEDU_LOCAL_PG_CONTAINER: container}, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      });
      process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
      const counts = tapCounts(result.stdout || '');
      const passed = result.status === 0 && counts.tests > 0 && counts.failed === 0 && counts.skipped === 0 && counts.cancelled === 0;
      results.push({suite: name, tests: counts, durationMs: Date.now() - startedAt, passed});
      if (!passed) throw new Error(`PostgreSQL suite ${name} failed, did not run, or skipped tests. ${result.error?.message || ''}`);
    }
    console.log('XUEDU_PG_RESULT ' + JSON.stringify({passed: true, migrations, suites: results}));
    return results;
  } finally {
    if (started) docker(['rm', '-f', container]);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPgSuites().catch(error => { console.error('Local PostgreSQL test failed:', error.message); process.exitCode = 1; });
}
