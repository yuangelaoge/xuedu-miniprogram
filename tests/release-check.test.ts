import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKS, inputSnapshot, artifactSnapshot, verifyManifest } from '../scripts/release-check.mjs';
import { PG_SUITES, selectSuites, migrationFiles, tapCounts } from '../scripts/v2-db-test.mjs';

function fixture(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'xuedu-release-check-'));
  try {
    mkdirSync(join(dir, 'miniprogram'), {recursive: true});
    mkdirSync(join(dir, 'cloudfunctions/xueduTrial/generated/v2'), {recursive: true});
    writeFileSync(join(dir, 'miniprogram/app.ts'), 'export const version = 1;');
    writeFileSync(join(dir, 'package.json'), '{"private":true}');
    writeFileSync(join(dir, 'cloudfunctions/xueduTrial/generated/v2/gateway.js'), 'module.exports = 1;');
    run(dir);
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('release evidence catches changed/new/removed sources and replaced cloud artifacts', () => {
  fixture(dir => {
    const manifest = {schemaVersion: 1, status: 'passed', inputs: inputSnapshot(dir), artifacts: artifactSnapshot(dir), checks: CHECKS.map(name => ({name, passed: true}))};
    assert.equal(verifyManifest(manifest, dir), true);
    writeFileSync(join(dir, 'miniprogram/app.ts'), 'export const version = 2;');
    assert.throws(() => verifyManifest(manifest, dir), /Source changed/);
    writeFileSync(join(dir, 'miniprogram/app.ts'), 'export const version = 1;');
    writeFileSync(join(dir, 'miniprogram/new.ts'), 'export {};');
    assert.throws(() => verifyManifest(manifest, dir), /Source changed/);
    rmSync(join(dir, 'miniprogram/new.ts'));
    rmSync(join(dir, 'miniprogram/app.ts'));
    assert.throws(() => verifyManifest(manifest, dir), /Source changed/);
    writeFileSync(join(dir, 'miniprogram/app.ts'), 'export const version = 1;');
    writeFileSync(join(dir, 'cloudfunctions/xueduTrial/generated/v2/gateway.js'), 'module.exports = 2;');
    assert.throws(() => verifyManifest(manifest, dir), /Cloud build changed/);
  });
});

test('release evidence never accepts an incomplete or failed check set', () => {
  fixture(dir => {
    const manifest = {schemaVersion: 1, status: 'passed', inputs: inputSnapshot(dir), artifacts: artifactSnapshot(dir), checks: CHECKS.map(name => ({name, passed: true}))};
    for (const name of CHECKS) assert.throws(() => verifyManifest({...manifest, checks: manifest.checks.filter(check => check.name !== name)}, dir), /complete passing/);
    assert.throws(() => verifyManifest({...manifest, status: 'failed'}, dir), /complete passing/);
    assert.throws(() => verifyManifest({...manifest, checks: manifest.checks.map(check => ({...check, passed: false}))}, dir), /complete passing/);
  });
});

test('release input hashes exclude credentials, personal workspace settings and generated files', () => {
  fixture(dir => {
    const initial = inputSnapshot(dir);
    writeFileSync(join(dir, 'project.private.config.json'), '{"local":"private"}');
    writeFileSync(join(dir, 'miniprogram/.env'), 'TOKEN=must-not-enter-evidence');
    writeFileSync(join(dir, 'miniprogram/app.js'), 'compiled');
    writeFileSync(join(dir, 'miniprogram/app.wxss'), 'compiled');
    writeFileSync(join(dir, 'cloudfunctions/xueduTrial/generated/v2/gateway.js'), 'rebuilt');
    assert.deepEqual(inputSnapshot(dir), initial);
    symlinkSync(join(dir, 'package.json'), join(dir, 'miniprogram/external.ts'));
    assert.throws(() => inputSnapshot(dir), /symbolic links/);
  });
});

test('PostgreSQL --all includes capacity and existing suites, validates flags and all current migrations', () => {
  assert.deepEqual(selectSuites(['--all']), Object.keys(PG_SUITES));
  assert.ok(selectSuites(['--all']).includes('capacity'));
  assert.deepEqual(selectSuites(['--page-scope']), ['page-scope']);
  assert.deepEqual(selectSuites(['--records', '--options', '--records']), ['records', 'options']);
  assert.throws(() => selectSuites(['--connection-string=production']), /Use --all/);
  const migrations = migrationFiles();
  assert.equal(migrations[0], '003-v2-resources.sql');
  assert.ok(migrations.includes('005-review-sandbox.sql'));
  assert.ok(migrations.includes('012-page-task-scope.sql'));
  assert.deepEqual(migrations, [...migrations].sort());
  assert.deepEqual(tapCounts('# tests 4\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 1\n'), {tests: 4, passed: 3, failed: 0, cancelled: 0, skipped: 1});
  assert.equal(tapCounts('no tests actually ran').tests, -1);
});
