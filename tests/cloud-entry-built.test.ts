import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import { buildCloud } from '../scripts/build-cloud.mjs';
import type { ApiResponse } from '../miniprogram/domain/v2/protocol';
import type { ReviewSession } from '../server/v2/review';
import type { ReviewSnapshot, ReviewRole } from '../server/v2/review-seed';

const APPID = 'wx5c7d4a458873c686';
const ENVIRONMENT = 'xuedu-trial-d2gs2dpnla9206eb3';
const password = 'synthetic-review-secret';
const salt = Buffer.alloc(16, 1);
const passwordHash = `scrypt$16384$8$1$${salt.toString('base64url')}$${crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('base64url')}`;
interface Result { ok: boolean; code?: string; error?: string; data?: ApiResponse; }

test('实际独立构建包的审核错误可跨入口识别，未知异常仍脱敏', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'xuedu-entry-built-'));
  try {
    await buildCloud(temporary);
    const requireBuilt = createRequire(import.meta.url);
    // Load the deployed CommonJS bundles, not TS source mocks that share one class.
    const modules = Object.fromEntries(['gateway', 'postgres', 'photos', 'review'].map(name =>
      [`./generated/v2/${name}.js`, requireBuilt(join(temporary, 'v2', name + '.js'))]));
    assert.notEqual(modules['./generated/v2/gateway.js'].BusinessError, modules['./generated/v2/review.js'].BusinessError);
    const source = readFileSync(new URL('../cloudfunctions/xueduTrial/index.js', import.meta.url), 'utf8');

    interface EntryOptions { readData?: unknown; }
    function entry(overrides: Record<string, string> = {}, rpcFailure?: unknown, rpcError?: unknown, options: EntryOptions = {}) {
      let session: ReviewSession | null = null;
      const calls: string[] = [];
      const exports: { main?: (event: unknown) => Promise<Result> } = {};
      const db = { async rpc(name: string, args: Record<string, unknown>) {
        calls.push(name);
        if (rpcFailure !== undefined) throw rpcFailure;
        if (rpcError !== undefined) return { data: null, error: rpcError };
        let data: unknown;
        switch (name) {
          case 'xuedu_review_login':
            if (args.p_valid) session = { snapshot: args.p_snapshot as ReviewSnapshot, version: 1, role: 'admin', expiresAt: String(args.p_expires_at) };
            data = args.p_valid; break;
          case 'xuedu_review_read': data = Object.hasOwn(options, 'readData') ? options.readData : session; break;
          case 'xuedu_review_role':
            assert.ok(session); session.role = args.p_role as ReviewRole; data = ++session.version; break;
          case 'xuedu_v2_workspace':
            data = { id: 'main', epoch: 'synthetic-epoch', version: 1, permissionsVersion: 1, protocolVersion: 2, activeSemesterId: '', maxExecutionMs: 3000, maintenance: '' }; break;
          case 'xuedu_v2_scheduling_read': return {data: null, error: {code: 'PGRST202'}}; // Prior-schema rollout fallback.
          case 'xuedu_v2_query': data = { items: [], cursor: '' }; break;
          default: throw new Error('Unexpected RPC ' + name);
        }
        return { data, error: null };
      } };
      runInNewContext(source, {
        exports, Buffer, process: { env: {
          SCF_NAMESPACE: ENVIRONMENT, CLOUDBASE_APIKEY: 'synthetic-server-key',
          FUNCTION_MAX_EXECUTION_MS: '3000', PLATFORM_FUNCTION_TIMEOUT_MS: '3000',
          REVIEW_ENABLED: 'true', REVIEW_PASSWORD_HASH: passwordHash,
          REVIEW_SESSION_KEY: 'a'.repeat(64), REVIEW_ACCESS_UNTIL: '2099-01-01T00:00:00.000Z', ...overrides,
        } },
        require(name: string) {
          if (Object.hasOwn(modules, name)) return modules[name];
          if (name === 'wx-server-sdk') return { init() {}, getWXContext: () => ({ OPENID: 'synthetic-reviewer', APPID }) };
          if (name === 'crypto') return crypto;
          if (name === '@cloudbase/js-sdk') return { init: () => ({ rdb: () => db, storage: { from: () => ({}) } }) };
          throw new Error('Unexpected module ' + name);
        },
      });
      assert.ok(exports.main);
      return {
        call: (operation: string, fields: Record<string, unknown> = {}) => exports.main!({ protocolVersion: 2, operation, review: true, ...fields }),
        login: () => exports.main!({ protocolVersion: 2, operation: 'reviewLogin', payload: { username: '审核老师辛苦了', password } }),
        session: () => { assert.ok(session); return session; }, calls,
      };
    }
    function failure(result: Result, code: string, message: string) {
      assert.equal(result.ok, false); assert.equal(result.code, code); assert.equal(result.error, message);
      assert.equal(result.data, undefined);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-reviewer|synthetic-server-key|synthetic-review-secret|sql-private|token-private/);
    }

    await t.test('缺失、过期或不属于审核工作区的会话返回 REVIEW_EXPIRED', async () => {
      const x = entry();
      failure(await x.call('bootstrap', { payload: { includeHome: true, fastPage: true } }), 'REVIEW_EXPIRED', '审核体验已到期，请重新登录');
      for (const corrupt of [
        (s: ReviewSession) => { s.expiresAt = '2000-01-01T00:00:00.000Z'; },
        (s: ReviewSession) => { s.snapshot.workspace.id = 'main'; },
        (s: ReviewSession) => { s.snapshot.workspace.epoch = 'production-epoch'; },
      ]) {
        assert.equal((await x.login()).ok, true); corrupt(x.session());
        failure(await x.call('bootstrap'), 'REVIEW_EXPIRED', '审核体验已到期，请重新登录');
      }
      assert.ok(x.calls.every(name => name.startsWith('xuedu_review_')));
    });
    await t.test('SDK 空对象、缺失字段和非法会话结构均安全返回到期码', async () => {
      const valid = entry(); assert.equal((await valid.login()).ok, true);
      const seed = valid.session();
      const invalid: unknown[] = [null, undefined, {}, [], false, '',
        { ...seed, expiresAt: undefined }, { ...seed, expiresAt: '' }, { ...seed, expiresAt: 'not-a-date' },
        { ...seed, expiresAt: 4070908800000 }, { ...seed, version: 0 }, { ...seed, version: '1' },
        { ...seed, role: undefined }, { ...seed, role: 'invalid' },
        { ...seed, snapshot: undefined }, { ...seed, snapshot: null }, { ...seed, snapshot: {} },
        { ...seed, snapshot: { ...seed.snapshot, workspace: {} } },
        { ...seed, snapshot: { ...seed.snapshot, workspace: { ...seed.snapshot.workspace, epoch: undefined } } },
        { ...seed, snapshot: { ...seed.snapshot, workspace: { ...seed.snapshot.workspace, protocolVersion: 1 } } },
        { ...seed, snapshot: { ...seed.snapshot, rows: undefined } },
        { ...seed, snapshot: { ...seed.snapshot, rows: { members: {} } } },
      ];
      for (const readData of invalid) {
        const x = entry({}, undefined, undefined, { readData });
        failure(await x.call('bootstrap'), 'REVIEW_EXPIRED', '审核体验已到期，请重新登录');
        assert.deepEqual(x.calls, ['xuedu_review_read']);
      }
    });
    const sdkFile = new URL('../cloudfunctions/xueduTrial/node_modules/@cloudbase/js-sdk/dist/index.node.cjs.js', import.meta.url);
    await t.test('真实 SDK 将 RPC null 转为 {} 后，构建包入口仍返回 REVIEW_EXPIRED', { skip: !existsSync(sdkFile) }, async () => {
      // Isolate SDK background timers; replace its transport before creating rdb().
      const probe = spawnSync(process.execPath, ['-e', `
        const sdk = require(process.argv[1]);
        const app = sdk.init({env:'synthetic-local-only',accessKey:'synthetic-no-network'});
        let fetches = 0;
        app.request.fetch = async () => {
          fetches++;
          return {statusCode:200,statusMessage:'OK',data:Promise.resolve(null),header:{}};
        };
        app.rdb().rpc('xuedu_review_read',{p_digest:'synthetic-digest'}).then(mapped => {
          process.stdout.write(JSON.stringify({data:mapped.data,error:mapped.error,fetches}));
          process.exit(0);
        }).catch(() => process.exit(1));
      `, fileURLToPath(sdkFile)], { encoding: 'utf8', timeout: 5000 });
      assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
      const mapped = JSON.parse(probe.stdout);
      assert.equal(mapped.error, null); assert.deepEqual(mapped.data, {});
      const x = entry({}, undefined, undefined, { readData: mapped.data });
      failure(await x.call('bootstrap', { payload: { includeHome: true, fastPage: true } }), 'REVIEW_EXPIRED', '审核体验已到期，请重新登录');
      assert.equal(mapped.fetches, 1);
    });
    await t.test('体验总期限和配置错误仍拒绝访问', async () => {
      failure(await entry({ REVIEW_ACCESS_UNTIL: '2000-01-01T00:00:00.000Z' }).call('bootstrap'), 'REVIEW_EXPIRED', '审核体验已到期');
      failure(await entry({ REVIEW_ENABLED: 'false' }).call('bootstrap'), 'CONFIGURATION', '审核体验尚未启用');
    });
    await t.test('登录、角色及审核隔离错误保留可信业务提示', async () => {
      const x = entry();
      failure(await x.call('reviewLogin', { payload: { username: '审核老师辛苦了', password: 'wrong' } }), 'REVIEW_LOGIN_FAILED', '账号或密码无效，或暂时无法登录');
      assert.equal((await x.login()).ok, true);
      failure(await x.call('reviewRole', { payload: { role: 'invalid' } }), 'INVALID_REQUEST', '体验角色无效');
      failure(await x.call('clearPreview'), 'FORBIDDEN', '审核会话无权执行此操作');
      assert.equal((await x.call('reviewRole', { payload: { role: 'member' } })).ok, true);
      // This error originates in the gateway nested inside review.js.
      failure(await x.call('query', { epoch: x.session().snapshot.workspace.epoch, payload: { kind: 'members' } }), 'FORBIDDEN', '没有管理权限');
      assert.ok(x.calls.every(name => name.startsWith('xuedu_review_')));
    });
    await t.test('普通模式仍走正式网关并识别其业务错误', async () => {
      const x = entry();
      const boot = await x.call('bootstrap', { review: false });
      assert.equal(boot.ok, true); assert.equal(boot.data?.data.status, 'preparing');
      failure(await x.call('query', { review: false, epoch: boot.data?.epoch, payload: { kind: 'members' } }), 'FORBIDDEN', '请先申请并通过审核');
      assert.ok(x.calls.every(name => name.startsWith('xuedu_v2_')));
    });
    await t.test('伪造业务错误字段和未知 SDK 异常不透传', async () => {
      for (const error of [
        new Error('sql-private token-private'),
        Object.assign(new Error('sql-private token-private'), { code: 'REVIEW_EXPIRED' }),
        { name: 'BusinessError', code: 'FORBIDDEN', message: 'sql-private token-private' },
      ]) failure(await entry({}, error).call('bootstrap'), 'INTERNAL_ERROR', '云端操作失败，请稍后重试');
      failure(await entry({}, undefined, { message: 'sql-private token-private' }).call('bootstrap'), 'REVIEW_STORE_UNAVAILABLE', '审核体验暂时不可用，请稍后再试');
      failure(await entry({}, undefined, { message: 'REVIEW_VERSION_CONFLICT sql-private token-private' }).call('bootstrap'), 'REVIEW_VERSION_CONFLICT', '审核样例已变化，请刷新后重试');
    });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
