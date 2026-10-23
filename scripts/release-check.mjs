import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PG_SUITES, tapCounts } from './v2-db-test.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CHECKS = Object.freeze(['typecheck', 'server-typecheck', 'unit', 'postgres', 'wxml', 'build']);
const INPUT_ROOTS = ['miniprogram', 'server', 'scripts', 'tests', 'typings', 'cloudbase/migrations', 'cloudfunctions/xueduTrial'];
const INPUT_FILES = ['AGENTS.md', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json',
  'project.config.json', 'project.miniapp.json', 'cloudfunctions/database.rules.json', 'cloudfunctions/storage.rules.json'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const portable = path => path.split(sep).join('/');
function relativePath(projectRoot, path) {
  const name = portable(relative(projectRoot, path));
  if (!name || name.startsWith('../') || name.startsWith('/') || name.includes('\0')) throw new Error('File must be inside the project.');
  return name;
}
function ignoreInput(path) {
  const parts = path.split('/');
  if (parts.some(name => ['node_modules', 'generated', '.git', 'artifacts', 'secrets'].includes(name))) return true;
  if (parts.at(-1).startsWith('.env') || path.endsWith('project.private.config.json') || /\.(pem|key|log)$/.test(path)) return true;
  return path.startsWith('miniprogram/') && !path.startsWith('miniprogram/assets/') && ['.js', '.wxss'].includes(extname(path));
}
function walk(projectRoot, dir, include) {
  if (!existsSync(dir)) return [];
  const info = lstatSync(dir);
  if (info.isSymbolicLink()) throw new Error('Release inputs must not be symbolic links: ' + relativePath(projectRoot, dir));
  if (!include(relativePath(projectRoot, dir))) return [];
  if (info.isFile()) return [relativePath(projectRoot, dir)];
  if (!info.isDirectory()) return [];
  return readdirSync(dir).sort().flatMap(name => walk(projectRoot, join(dir, name), include));
}
export function hashFiles(projectRoot, paths) {
  return Object.fromEntries([...new Set(paths)].sort().map(path => {
    const absolute = resolve(projectRoot, path);
    if (relativePath(projectRoot, absolute) !== path || lstatSync(absolute).isSymbolicLink()) throw new Error('Unsafe manifest path: ' + path);
    return [path, sha256(readFileSync(absolute))];
  }));
}
export function inputSnapshot(projectRoot = root) {
  const paths = [...INPUT_ROOTS.flatMap(path => walk(projectRoot, resolve(projectRoot, path), name => !ignoreInput(name))),
    ...INPUT_FILES.filter(path => existsSync(resolve(projectRoot, path)))];
  const files = hashFiles(projectRoot, paths);
  return {files, sha256: sha256(JSON.stringify(files))};
}
export function artifactSnapshot(projectRoot = root) {
  const paths = walk(projectRoot, resolve(projectRoot, 'cloudfunctions/xueduTrial/generated'), () => true);
  if (!paths.length) throw new Error('Cloud build artifacts are missing.');
  return hashFiles(projectRoot, paths);
}
export function verifyManifest(manifest, projectRoot = root) {
  if (manifest.schemaVersion !== 1 || manifest.status !== 'passed' || !CHECKS.every(name => manifest.checks?.some(check => check.name === name && check.passed === true))) {
    throw new Error('Manifest does not prove a complete passing release check.');
  }
  const current = inputSnapshot(projectRoot);
  if (current.sha256 !== manifest.inputs?.sha256 || JSON.stringify(current.files) !== JSON.stringify(manifest.inputs?.files)) throw new Error('Source changed since the release check; run check:release again.');
  if (JSON.stringify(artifactSnapshot(projectRoot)) !== JSON.stringify(manifest.artifacts)) throw new Error('Cloud build changed since the release check; run check:release again.');
  return true;
}
export function unitTestFiles(projectRoot = root) {
  const all = readdirSync(resolve(projectRoot, 'tests')).filter(name => name.endsWith('.test.ts')).map(name => 'tests/' + name).sort();
  const postgres = new Set(Object.values(PG_SUITES));
  for (const path of all) if (readFileSync(resolve(projectRoot, path), 'utf8').includes('XUEDU_LOCAL_PG_CONTAINER') && !postgres.has(path)) {
    throw new Error('Unregistered PostgreSQL suite: ' + path);
  }
  for (const path of postgres) if (!all.includes(path)) throw new Error('Missing PostgreSQL suite: ' + path);
  return all.filter(path => !postgres.has(path));
}
async function runStep(name, args, directory) {
  const logPath = join(directory, name + '.log');
  const stream = createWriteStream(logPath);
  const start = Date.now();
  console.log(`Release check: ${name}`);
  let output = '';
  let stderr = '';
  const code = await new Promise((accept, reject) => {
    const env = {...process.env};
    // Do not let an inherited database-test setting redirect or unexpectedly enable fixtures.
    delete env.XUEDU_LOCAL_PG_CONTAINER;
    const child = spawn(process.execPath, args, {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', data => { output += data; stream.write(data); });
    child.stderr.on('data', data => { stderr += data; stream.write(data); });
    child.on('error', reject); child.on('close', value => accept(value));
  }).finally(() => new Promise(accept => stream.end(accept)));
  const counts = name === 'unit' ? tapCounts(output) : undefined;
  const passed = code === 0 && (!counts || counts.tests > 0 && counts.failed === 0 && counts.skipped === 0 && counts.cancelled === 0);
  const result = {name, passed, exitCode: code, durationMs: Date.now() - start, log: portable(relative(directory, logPath)), ...(counts ? {tests: counts} : {})};
  if (name === 'postgres') {
    const line = output.split('\n').find(line => line.startsWith('XUEDU_PG_RESULT '));
    if (!line) result.passed = false;
    else result.database = JSON.parse(line.slice('XUEDU_PG_RESULT '.length));
  }
  if (!result.passed) console.error((output + '\n' + stderr).slice(-8000));
  console.log(`${name}: ${result.passed ? 'passed' : 'FAILED'} (${result.durationMs} ms)`);
  return result;
}

export async function runReleaseCheck() {
  const start = new Date();
  const directory = resolve(root, 'artifacts/release-check', start.toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
  mkdirSync(directory, {recursive: true});
  const initial = inputSnapshot();
  const manifest = {schemaVersion: 1, status: 'running', startedAt: start.toISOString(), nodeVersion: process.version,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    inputs: initial, checks: [], artifacts: {},
    scope: 'Local synthetic data only; no cloud queries, deployment, upload or business-data changes.',
    manualAcceptance: ['Android and iPhone photo upload and page switching', 'Authorized release upload and read-back of actual version'],
  };
  const path = join(directory, 'manifest.json');
  try {
    const commands = [
      ['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']],
      ['server-typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json']],
      ['unit', ['--import', 'tsx', '--test', '--test-reporter=tap', ...unitTestFiles()]],
      ['postgres', ['scripts/v2-db-test.mjs', '--all']],
      ['wxml', ['scripts/check-wxml.mjs']],
      ['build', ['scripts/build-cloud.mjs']],
    ];
    for (const [name, args] of commands) {
      const result = await runStep(name, args, directory);
      manifest.checks.push(result);
      if (!result.passed) throw new Error('Release check failed: ' + name);
      if (inputSnapshot().sha256 !== initial.sha256) throw new Error('Source changed while checks were running; repeat on an unchanged candidate.');
    }
    manifest.artifacts = artifactSnapshot();
    manifest.status = 'passed';
  } catch (error) {
    manifest.status = 'failed'; manifest.failure = error.message; throw error;
  } finally {
    manifest.finishedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
    console.log('Release evidence: ' + path);
  }
  console.log('All local checks passed. Phone acceptance and production release are separate.');
  return path;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--verify' && args.length === 2) {
    try { verifyManifest(JSON.parse(readFileSync(resolve(args[1]), 'utf8'))); console.log('Source and cloud artifacts match the passing release check. No upload performed.'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  } else if (args.length) { console.error('Use no arguments, or --verify artifacts/release-check/.../manifest.json'); process.exitCode = 1; }
  else runReleaseCheck().catch(error => { console.error(error.message); process.exitCode = 1; });
}
