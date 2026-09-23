import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline only: no SDK, network, credentials, database writes or photo deletion.
export const TARGET = Object.freeze({ environmentId: 'xuedu-trial-d2gs2dpnla9206eb3', functionName: 'xueduTrial' });
const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.length > 0;
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function unique(items, key, code) {
  const seen = new Set();
  for (const item of items) {
    if (!string(item[key]) || seen.has(item[key])) fail(code);
    seen.add(item[key]);
  }
}

/** Envelope must come from a controlled server-side export, never a role-filtered snapshot. */
export function createCutoverPlan(source, options = {}) {
  if (!object(source) || source.environmentId !== TARGET.environmentId || source.functionName !== TARGET.functionName) fail('TARGET_MISMATCH');
  const doc = source.document;
  if (!Number.isSafeInteger(source.revision) || source.revision < 0 || !object(doc) || doc.stage !== 'trial' ||
      !string(doc.epoch) || !Number.isSafeInteger(doc.version) || doc.version < 0 || !object(doc.state)) fail('INVALID_SOURCE');
  if (doc.cleaning || doc.resetAll || doc.businessClear) fail('UNFINISHED_LEGACY_MAINTENANCE');
  const state = doc.state;
  for (const key of ['members', 'classes', 'semesters', 'applications', 'courses', 'availability', 'plans', 'drafts', 'records', 'audit']) {
    if (!Array.isArray(state[key]) || state[key].some(item => !object(item))) fail('INVALID_SOURCE_ARRAY');
  }
  if (!Array.isArray(doc.files)) fail('INVALID_PHOTO_REGISTRY');
  unique(state.members, 'id', 'DUPLICATE_MEMBER_ID');
  unique(state.classes, 'id', 'DUPLICATE_CLASS_ID');
  const admins = state.members.filter(member => member.role === 'admin');
  if (!admins.some(member => member.active === true)) fail('NO_ACTIVE_ADMINISTRATOR');
  for (const member of admins) {
    if (typeof member.active !== 'boolean' || !string(member.name) || !string(member.studentNo) ||
        !string(member.classId) || !string(member.identityKey) || member.identityKey === 'self') fail('INVALID_ADMINISTRATOR');
  }
  unique(admins, 'studentNo', 'DUPLICATE_ADMIN_STUDENT_NUMBER');
  unique(admins, 'identityKey', 'DUPLICATE_ADMIN_BINDING');
  const classIds = new Set(admins.map(member => member.classId));
  const classes = state.classes.filter(schoolClass => classIds.has(schoolClass.id));
  if (classes.length !== classIds.size) fail('MISSING_ADMINISTRATOR_CLASS');
  for (const item of classes) if (!string(item.name) || !string(item.grade) || !string(item.major)) fail('INVALID_CLASS');
  const epoch = options.epoch || randomUUID();
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(epoch) || epoch === doc.epoch) fail('INVALID_NEW_EPOCH');
  const maxExecutionMs = options.maxExecutionMs;
  if (!Number.isSafeInteger(maxExecutionMs) || maxExecutionMs < 1000 || maxExecutionMs > 900000) fail('INVALID_EXECUTION_LIMIT');
  const sourceDigest = digest(source);
  const id = 'cutover-' + sourceDigest.slice(0, 24);
  const entity = (id, data, indexes = {}) => ({ id, epoch, version: 1, data: clone(data), ...indexes });
  const members = admins.map(member => {
    const { identityKey, ...data } = member;
    return entity(member.id, data, { studentNo: member.studentNo });
  }).sort((a, b) => a.id.localeCompare(b.id));
  const bindings = admins.map(member => entity('binding-' + member.id, { memberId: member.id, active: member.active },
    { identityKey: member.identityKey, memberId: member.id })).sort((a, b) => a.id.localeCompare(b.id));
  const retained = { members, bindings, classes: classes.map(item => entity(item.id, item)).sort((a, b) => a.id.localeCompare(b.id)) };
  const plan = {
    format: 'xuedu-v2-cutover-1', id, target: { ...TARGET },
    source: { stage: doc.stage, epoch: doc.epoch, revision: source.revision, version: doc.version, sha256: sourceDigest },
    workspace: { id: 'main', epoch, version: 1, permissionsVersion: 1, protocolVersion: 2,
      activeSemesterId: '', maintenance: id, maxExecutionMs },
    retained,
    summary: { administrators: admins.length, activeAdministrators: admins.filter(member => member.active).length,
      retainedClasses: classes.length, deletedClasses: state.classes.length - classes.length,
      removedMembers: state.members.length - admins.length, semesters: state.semesters.length,
      records: state.records.length, registeredPhotos: doc.files.length },
    photoPolicy: { deleteAutomatically: false, inventoryRequired: true, legacyStage: doc.stage, legacyEpoch: doc.epoch },
    destructiveActionsAuthorized: false,
  };
  return { ...plan, sha256: digest(plan) };
}

/** Independently compare a privileged export of all V2 resources before any destructive action. */
export function verifyCutover(plan, originalSource, imported) {
  if (!object(plan)) fail('INVALID_PLAN');
  const { sha256, ...body } = plan;
  if (digest(body) !== sha256) fail('PLAN_HASH_MISMATCH');
  const rebuilt = createCutoverPlan(originalSource, { epoch: plan.workspace.epoch, maxExecutionMs: plan.workspace.maxExecutionMs });
  if (digest(rebuilt) !== digest(plan)) fail('SOURCE_OR_PLAN_CHANGED');
  if (!object(imported) || digest(imported.target) !== digest(plan.target) || !object(imported.workspace) || !object(imported.resources)) fail('INVALID_VERIFICATION_EXPORT');
  if (digest(imported.workspace) !== digest(plan.workspace)) fail('WORKSPACE_MISMATCH');
  for (const resource of ['members', 'bindings', 'classes']) {
    const items = imported.resources[resource];
    if (!Array.isArray(items)) fail('MISSING_RETAINED_RESOURCE');
    const sorted = [...items].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (digest(sorted) !== digest(plan.retained[resource])) fail('RETAINED_RESOURCE_MISMATCH');
  }
  const otherResources = ['applications', 'semesters', 'semester_classes', 'courses', 'course_versions', 'occurrences', 'exceptions',
    'availability', 'plans', 'tasks', 'records', 'record_versions', 'photos', 'audit', 'requests', 'maintenance', 'rebindings'];
  for (const resource of otherResources) {
    // A complete export is mandatory: omission is not evidence of an empty table.
    if (!Array.isArray(imported.resources[resource]) || imported.resources[resource].length) fail('UNEXPECTED_OR_MISSING_RESOURCE');
  }
  if (Object.keys(imported.resources).some(key => ![...Object.keys(plan.retained), ...otherResources].includes(key))) fail('UNKNOWN_RESOURCE');
  return { verified: true, planSha256: sha256, sourceSha256: plan.source.sha256, ...plan.summary,
    destructiveActionsAuthorized: false };
}

function repositoryAncestor(path) {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true;
    if (dirname(current) === current) return false;
  }
}
export function writeCutoverMaterials(inputPath, outputPath, options) {
  const sourceText = readFileSync(inputPath, 'utf8');
  const source = JSON.parse(sourceText);
  const plan = createCutoverPlan(source, options);
  const output = resolve(outputPath);
  if (!existsSync(dirname(output))) fail('OUTPUT_PARENT_MUST_EXIST');
  const parent = realpathSync(dirname(output));
  if (repositoryAncestor(parent)) fail('OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
  // A fresh directory prevents overwriting previous recovery material or following output symlinks.
  const safeOutput = join(parent, output.split('/').pop());
  mkdirSync(safeOutput, { mode: 0o700 });
  const write = (name, text) => writeFileSync(join(safeOutput, name), text, { mode: 0o600, flag: 'wx' });
  write('legacy-recovery.json', sourceText);
  write('retention-plan.json', JSON.stringify(plan, null, 2) + '\n');
  write('checksums.json', JSON.stringify({ sourceFileSha256: createHash('sha256').update(sourceText).digest('hex'),
    sourceCanonicalSha256: plan.source.sha256, planSha256: plan.sha256 }, null, 2) + '\n');
  return { ...plan.summary, planSha256: plan.sha256, sourceSha256: plan.source.sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, ...args] = process.argv.slice(2);
    if (operation === 'plan' && args.length === 3) {
      console.log(JSON.stringify(writeCutoverMaterials(args[0], args[1], { maxExecutionMs: Number(args[2]) })));
    } else if (operation === 'verify' && args.length === 3) {
      const [plan, source, imported] = args.map(path => JSON.parse(readFileSync(path, 'utf8')));
      console.log(JSON.stringify(verifyCutover(plan, source, imported)));
    } else fail('USAGE: plan SOURCE OUTPUT_DIRECTORY MAX_EXECUTION_MS | verify PLAN SOURCE V2_EXPORT');
  } catch (error) {
    // Native errors can include paths; JSON errors can include private input. Never print their messages.
    const safe = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'CUTOVER_FAILED_CHECK_LOCAL_INPUT';
    console.error(safe); process.exitCode = 1;
  }
}
