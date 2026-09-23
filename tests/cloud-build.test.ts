import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCloud } from '../scripts/build-cloud.mjs';

test('云函数只构建V2三模块并排除旧聚合逻辑、示例种子和生产副本', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'xuedu-v2-build-'));
  try {
    writeFileSync(join(temporary, 'gateway.js'), 'stale legacy generated artifact');
    const manifest = await buildCloud(temporary);
    assert.equal(manifest.protocolVersion, 2); assert.equal(manifest.functionName, 'xueduTrial');
    assert.equal(existsSync(join(temporary, 'gateway.js')), false);
    assert.equal(manifest.artifacts.length, 3);
    for (const input of ['server/gateway.ts', 'server/postgres.ts', 'server/policy.ts', 'miniprogram/domain/seed.ts'])
      assert.equal(manifest.inputs.includes(input), false, input);
    for (const name of ['gateway', 'postgres', 'photos']) assert.ok(existsSync(join(temporary, 'v2', name + '.js')));
    const bundled = manifest.artifacts.map(path => readFileSync(join(temporary, path), 'utf8')).join('\n');
    assert.doesNotMatch(bundled, /xuedu_read_workspace|xuedu_commit_workspace|resetAllBegin|businessClearBegin|createSeed/);
    assert.match(bundled, /createGatewayV2/); assert.match(bundled, /xuedu_v2_commit/);
    assert.equal(existsSync(join(temporary, 'xueduProduction')), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
