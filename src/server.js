import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent, request as undiciRequest } from 'undici';
import {
  runPay,
  runLink,
  validateCard,
  assertAccountCanSubscribe,
  classifyProviderPaymentError,
  isPrepaymentInvoiceMismatch,
  paymentErrorFromPayload
} from './payment.js';
import { classifyPaymentStatus } from './payment-status.js';
import * as stripe from './stripe.js';
import { parseCards, randomName } from './cardparse.js';
import { parseAddresses, validateAddress } from './addrparse.js';
import { generateAddress, generateBatch } from './addrgen.js';
import { IMPS } from './fprints.js';
import { parseResourceFile } from './resource-importers.js';
import { createResourceStore } from './resource-store.js';
import { createPaymentTaskStore } from './payment-task-store.js';
import { resolveToken } from './browser.js';
import * as cg from './chatgpt.js';
import {
  paymentFailureAction,
  paymentResourcePolicy,
  safePaymentErrorCode,
  providerPaymentErrorCode
} from './payment-error.js';
import { detectAccountStatus } from './account-status.js';
import { createThreeDsObserver } from './three-ds-observer.js';
import { createProxyConfig } from './proxy-config.js';
import { createAccountContextCache } from './account-context-cache.js';
import { createFingerprintProvider } from './fingerprint-provider.js';
import {
  createProxyLeaseRegistry,
  createResourceWakeSignal,
  createTaskResourceCoordinator
} from './task-resource-coordinator.js';
// 代理池：PROXY_POOL 逗号分隔多个代理，并行任务按序号分配不同出口 IP；
// 未配置时回落 CF_PROXY / HTTPS_PROXY 单代理；都没有则直连
const fingerprintProvider = createFingerprintProvider({
  profiles: IMPS.map((impersonation, index) => ({
    id: `fp_builtin_${index + 1}`,
    label: `Built-in / ${impersonation}`,
    impersonation
  }))
});
const impFor = i => {
  const profiles = fingerprintProvider.snapshot();
  return profiles[Math.abs(Number(i) || 0) % profiles.length].impersonation;
};
// 并发池：最多 conc 个任务同时执行
async function runPool(items, conc, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(conc, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}
// 支持命令行参数（Kimi Work 预览会传入 --port/--host），优先级：CLI > 环境变量 > 默认
const argOf = name => {
  const i = process.argv.indexOf('--' + name);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find(a => a.startsWith('--' + name + '='));
  return eq ? eq.split('=')[1] : '';
};
const PORT = Number(argOf('port') || process.env.PORT || 3456);
const HOST = argOf('host') || process.env.HOST || '0.0.0.0';
const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const PUBLIC = path.join(ROOT, '..', 'public');
const STORAGE_ROOT = process.env.DIPAY_STORAGE_ROOT ? path.resolve(process.env.DIPAY_STORAGE_ROOT) : path.join(ROOT, '..');
const ACCOUNTS_DIR = path.join(STORAGE_ROOT, 'accounts');
const CARDS_DIR = path.join(STORAGE_ROOT, 'cards');
const ADDR_DIR = path.join(STORAGE_ROOT, 'addresses');
const OUT_DIR = path.join(STORAGE_ROOT, 'out');
const CONFIG_ADDR = path.join(ROOT, '..', 'config', 'address.json');
const CONFIG_PROXY = path.join(STORAGE_ROOT, 'config', 'proxy.json');
let activeProxyTests = 0;
const proxyConfig = createProxyConfig({
  file: CONFIG_PROXY,
  testRequest: async proxy => {
    if (process.env.DIPAY_FAKE_PROXY_TEST === '1') {
      const host = (() => { try { return new URL(proxy).hostname; } catch { return 'invalid'; } })();
      activeProxyTests++;
      auditTestEvent({ type: 'proxy-test-start', host, active: activeProxyTests });
      let ok = false;
      try {
        await wait(Math.max(0, Number(process.env.DIPAY_FAKE_PROXY_TEST_DELAY_MS) || 0));
        if (host.includes('dead')) throw new Error('proxy connection failed');
        ok = true;
        return { detail: host };
      } finally {
        auditTestEvent({ type: 'proxy-test-end', host, active: activeProxyTests, ok });
        activeProxyTests--;
      }
    }
    const dispatcher = new ProxyAgent(proxy);
    try {
      const response = await undiciRequest('https://api.ipify.org?format=json', {
        dispatcher,
        signal: AbortSignal.timeout(4_000),
        headersTimeout: 4_000,
        bodyTimeout: 4_000
      });
      const body = await response.body.json();
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('proxy test failed');
      return { detail: String(body?.ip || '') };
    } finally {
      await dispatcher.close().catch(() => {});
    }
  }
});
const proxyFor = i => proxyConfig.proxyFor(i);
const resources = createResourceStore(STORAGE_ROOT);
const paymentTasks = createPaymentTaskStore(STORAGE_ROOT);
const accountContexts = createAccountContextCache();
const proxyLeaseRegistry = createProxyLeaseRegistry();
const resourceWakeSignal = createResourceWakeSignal();
const activeTaskProxyLeases = new Map();
const activePaymentTasks = new Set();
const activeBatchRuns = new Map();
const activeAccountChecks = new Set();
const forcedReservationConflicts = new Set();
let singleProxyCursor = 0;
let singleFingerprintCursor = 0;
const taskResources = task => [
  ['accounts', task.accountResourceId],
  ['cards', task.cardResourceId],
  ['addresses', task.addressResourceId]
].filter(([, id]) => id);

function assignTaskFingerprint(task, ordinal = 0) {
  if (!task?.id) return { task, profile: null };
  const profile = fingerprintProvider.acquire({ ownerId: task.id, ordinal });
  const updated = paymentTasks.update(task.id, {
    fingerprintId: profile.id,
    fingerprintLabel: profile.label,
    fingerprintReused: profile.reused,
    fingerprintProfile: profile
  });
  return { task: updated || task, profile };
}

function registerTaskProxyLease(taskId, coordinator, ownerId, index = -1) {
  if (!taskId || !coordinator || !ownerId) return;
  activeTaskProxyLeases.set(taskId, { coordinator, ownerId, index });
}

function releaseTaskProxyLease(taskId) {
  const lease = activeTaskProxyLeases.get(taskId);
  if (!lease) return false;
  activeTaskProxyLeases.delete(taskId);
  return lease.coordinator
    ? lease.coordinator.releaseProxy(lease.ownerId)
    : proxyLeaseRegistry.release(lease.ownerId);
}

function markTaskProxyUnhealthy(taskId) {
  const lease = activeTaskProxyLeases.get(taskId);
  if (!lease || !Number.isInteger(lease.index) || lease.index < 0) return false;
  lease.coordinator?.markProxyHealth(lease.index, {
    ok: false,
    error: 'proxy_connection_failed'
  });
  proxyConfig.recordHealthAt(lease.index, {
    ok: false,
    error: 'proxy_connection_failed'
  });
  return true;
}

function releaseResource(kind, id, taskId, outcome = {}) {
  if (!id) return false;
  const released = resources.release(kind, id, taskId, outcome);
  if (released) resourceWakeSignal.notify(`${kind}_release`);
  return released;
}

function markCardInsufficientResource(id, taskId) {
  const marked = resources.markCardInsufficient(id, taskId);
  if (marked) resourceWakeSignal.notify('card_blocked');
  return marked;
}

function auditTestEvent(event) {
  const file = String(process.env.DIPAY_TEST_AUDIT_FILE || '');
  if (!file) return;
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function paymentAuditEvent(type, task, payload, extra = {}) {
  let session = payload?.sessionJson;
  try { if (typeof session === 'string') session = JSON.parse(session); } catch { session = {}; }
  auditTestEvent({
    type,
    taskId: task.id,
    networkSlot: task.networkSlot,
    accountResourceId: task.accountResourceId || '',
    cardResourceId: task.cardResourceId || '',
    addressResourceId: task.addressResourceId || '',
    email: String(session?.user?.email || ''),
    cardLast4: String(payload?.card?.number || '').replace(/\D/g, '').slice(-4),
    city: String(payload?.address?.city || ''),
    proxy: String(payload?.proxy || ''),
    imp: String(payload?.imp || ''),
    ...extra
  });
}

function emailFromSession(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const email = String(parsed?.user?.email || '').trim();
    return email.includes('@') ? email : '';
  } catch {
    return '';
  }
}

function releaseTaskResources(task, paid, recordUsage = true, cardCooldownMs = 0) {
  for (const [kind, id] of taskResources(task)) {
    releaseResource(kind, id, task.id, { paid, recordUsage, cooldownMs: kind === 'cards' ? cardCooldownMs : 0 });
  }
}

function finishFailedTaskResources(task) {
  if (!task) return paymentResourcePolicy({});
  const policy = paymentResourcePolicy(task);
  if (policy.hold) return policy;
  if (policy.card === 'blocked' && task.cardResourceId) {
    markCardInsufficientResource(task.cardResourceId, task.id);
    releaseResource('accounts', task.accountResourceId, task.id);
    releaseResource('addresses', task.addressResourceId, task.id);
    return policy;
  }
  releaseTaskResources(task, false, true, policy.card === 'cooldown' ? 30_000 : 0);
  return policy;
}

function finishSuccessfulTaskResources(task, { release = true } = {}) {
  if (!task) return;
  if (task.cardResourceId) resources.recordCardEvent(task.cardResourceId, task.id, 'succeeded');
  if (task.accountResourceId && Number.isSafeInteger(task.amount) && task.amount > 0 && task.currency) {
    const via3ds = task.state === 'completing_3ds'
      || task.completionSource === 'account_tier_after_3ds'
      || Boolean(task.threeDsDetectedAt);
    const completed = resources.completeAccount(task.accountResourceId, {
      taskId: task.id,
      amount: task.amount,
      currency: task.currency,
      plan: task.plan,
      ...(via3ds ? { via3ds: true, accountPlanBefore: task.accountPlanBefore } : {})
    });
    if (!completed) {
      const error = new Error('account resource could not be completed');
      error.code = 'account_resource_not_found';
      throw error;
    }
  }
  if (release) releaseTaskResources(task, true, true, 30_000);
}

function pendingThreeDsPatch(detectedAt = Date.now()) {
  const firstAccountCheckAt = new Date(detectedAt + 120_000).toISOString();
  return {
    threeDsDetectedAt: new Date(detectedAt).toISOString(),
    firstAccountCheckAt,
    nextAccountCheckAt: firstAccountCheckAt
  };
}

function acquireAccountCheck(id) {
  const accountId = String(id || '');
  if (!accountId || activeAccountChecks.has(accountId)) return false;
  activeAccountChecks.add(accountId);
  return true;
}

function releaseAccountCheck(id) {
  activeAccountChecks.delete(String(id || ''));
}

function accountNetwork(slot = 0, boundProxy = '') {
  return { proxy: boundProxy || proxyFor(slot), imp: impFor(slot) };
}

function detectStoredAccountStatus(account, slot = 0, boundProxy = '', token = '') {
  if (process.env.DIPAY_FAKE_ACCOUNT_STATUS_CHECK === '1') {
    const state = String(process.env.DIPAY_FAKE_ACCOUNT_STATUS_STATE || 'free').trim().toLowerCase();
    const plan = String(
      process.env.DIPAY_FAKE_ACCOUNT_STATUS_PLAN
      || (state === 'free' ? 'chatgptfreeplan' : '')
    ).trim();
    return wait(Math.max(0, Number(process.env.DIPAY_FAKE_ACCOUNT_STATUS_DELAY_MS) || 0))
      .then(() => ({ state, plan, errorCode: '' }));
  }
  return detectAccountStatus(account, {
    ...accountNetwork(slot, boundProxy),
    ...(token ? { token } : {}),
    includeCredential: true
  });
}

async function loadStoredAccountContext(id, account, slot = 0, boundProxy = '') {
  const network = accountNetwork(slot, boundProxy);
  const { token, email } = await resolveToken(JSON.stringify(account), network);
  const status = await detectStoredAccountStatus(account, slot, boundProxy, token);
  return {
    token: String(status.token || token),
    email: String(status.email || email || account?.user?.email || ''),
    status
  };
}

function startAccountStatusCheck(id, slot = 0) {
  if (process.env.DIPAY_DISABLE_ACCOUNT_STATUS_CHECK === '1') return Promise.resolve();
  const account = resources.get('accounts', id);
  const view = resources.list('accounts').find(item => item.id === id);
  if (!account || view?.payment?.state === 'completed') return Promise.resolve();
  if (!acquireAccountCheck(id)) {
    return accountContexts.load(id, () => loadStoredAccountContext(id, account, slot))
      .then(context => context.status);
  }
  resources.updateAccountStatus(id, { state: 'pending' });
  auditTestEvent({ type: 'account-check-start', id, email: String(account.user?.email || ''), active: activeAccountChecks.size });
  return accountContexts.load(id, () => loadStoredAccountContext(id, account, slot))
    .then(context => {
      resources.updateAccountStatus(id, context.status);
      return context.status;
    })
    .catch(() => resources.updateAccountStatus(id, { state: 'error', errorCode: 'account_status_check_failed' }))
    .finally(() => {
      releaseAccountCheck(id);
      auditTestEvent({ type: 'account-check-end', id, email: String(account.user?.email || ''), active: activeAccountChecks.size });
    });
}

function accountImportError(error) {
  const reason = String(error?.reason || '');
  return {
    line: error?.line ?? null,
    errorCode: reason === 'invalid account credential'
      || reason === 'no recognizable account credential'
      ? 'invalid_account_credential'
      : 'account_status_check_failed'
  };
}

async function importAccountFile(file) {
  const parsed = parseResourceFile('accounts', file);
  const rejectedItems = parsed.errors.map(accountImportError);
  const shouldDetect = process.env.DIPAY_DISABLE_ACCOUNT_STATUS_CHECK !== '1';
  const candidates = parsed.records.map((record, index) => ({
    record,
    line: parsed.lines?.[index] ?? null,
    index
  }));

  const inspected = await runPool(candidates, 3, async candidate => {
    if (!shouldDetect) return { ...candidate, context: null };
    const auditId = `import_${crypto.createHash('sha256')
      .update(JSON.stringify(candidate.record))
      .digest('hex')
      .slice(0, 24)}`;
    auditTestEvent({
      type: 'account-check-start',
      id: auditId,
      email: String(candidate.record?.user?.email || ''),
      active: activeAccountChecks.size + 1
    });
    try {
      const context = await loadStoredAccountContext(auditId, candidate.record, candidate.index);
      return { ...candidate, context };
    } catch {
      return {
        ...candidate,
        context: {
          token: String(candidate.record?.accessToken || ''),
          email: String(candidate.record?.user?.email || ''),
          status: { state: 'error', plan: '', errorCode: 'account_status_check_failed' }
        }
      };
    } finally {
      auditTestEvent({
        type: 'account-check-end',
        id: auditId,
        email: String(candidate.record?.user?.email || ''),
        active: activeAccountChecks.size
      });
    }
  });

  let added = 0;
  let duplicate = 0;
  const ids = [];
  for (const candidate of inspected) {
    if (candidate.context?.status?.state === 'invalid') {
      rejectedItems.push({ line: candidate.line, errorCode: 'invalid_account_credential' });
      continue;
    }
    const record = candidate.context ? {
      ...candidate.record,
      ...(candidate.context.token ? { accessToken: candidate.context.token } : {}),
      user: {
        ...(candidate.record.user || {}),
        ...(candidate.context.email ? { email: candidate.context.email } : {})
      }
    } : candidate.record;
    const saved = resources.add('accounts', record, { file: file.name, line: candidate.line });
    if (saved.status === 'added') added++;
    else duplicate++;
    accountContexts.invalidate(saved.id);
    if (candidate.context) {
      resources.updateAccountStatus(saved.id, candidate.context.status);
      accountContexts.prime(saved.id, {
        token: String(candidate.context.token || record.accessToken || ''),
        email: String(candidate.context.email || record.user?.email || ''),
        status: candidate.context.status
      });
    }
    ids.push(saved.id);
  }

  const itemsById = new Map(resources.list('accounts').map(item => [item.id, item]));
  return {
    file: file.name,
    added,
    duplicate,
    rejected: rejectedItems.length,
    items: [...new Set(ids)].map(id => itemsById.get(id)).filter(Boolean),
    errors: rejectedItems
  };
}

const threeDsObserver = createThreeDsObserver({
  paymentTasks,
  resources,
  acquireAccountCheck,
  releaseAccountCheck,
  checkAccountStatus: async ({ task, account }) => {
    const cached = accountContexts.peek(task.accountResourceId);
    const status = await detectStoredAccountStatus(account, task.networkSlot, task.networkProxy, cached?.token || '');
    resources.updateAccountStatus(task.accountResourceId, status);
    return status;
  },
  claimCompletion: (id, patch) => paymentTasks.claimThreeDsCompletion(id, patch),
  finishSuccessfulTask: task => {
    finishSuccessfulTaskResources(task);
    fingerprintProvider.release(task.id);
    releaseTaskProxyLease(task.id);
  },
  finishFailedTask: task => {
    finishFailedTaskResources(task);
    fingerprintProvider.release(task.id);
    releaseTaskProxyLease(task.id);
  },
  onError: (_error, context) => {
    console.warn(`[three-ds-observer ${String(context?.taskId || '')}] observer_internal_error`);
  }
});
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}
async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  let size = 0, body = '';
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    body += chunk;
  }
  return JSON.parse(body || '{}');
}
// 目录中 <prefix>-<n>.json 命名的下一个可用序号（按实际文件名取最大 n，避免留洞后覆盖）
function nextIndex(dir, re) {
  let max = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(re);
      if (m) max = Math.max(max, +m[1]);
    }
  }
  return max + 1;
}
// 按文件名末尾序号自然排序（card-尾号-N.json / addr-N.json）→ 保持导入时的先后顺序
function natSort(files) {
  return [...files].sort((a, b) => {
    const na = +((a.match(/(\d+)\.json$/) || [])[1] || 0);
    const nb = +((b.match(/(\d+)\.json$/) || [])[1] || 0);
    return na - nb || a.localeCompare(b);
  });
}
// 账号顺序：按导入时写入的 _seq 序号（= 粘贴顺序），无 _seq 的旧数据排最后
function accountOrder(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  return files.sort((a, b) => {
    const sa = readJson(path.join(dir, a), {})._seq ?? Infinity;
    const sb = readJson(path.join(dir, b), {})._seq ?? Infinity;
    return sa - sb || a.localeCompare(b);
  });
}
// 当前账号库中最大的 _seq（新导入从 +1 开始编号）
function maxSeq(dir) {
  let max = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const s = readJson(path.join(dir, f), {})._seq;
      if (Number.isFinite(s)) max = Math.max(max, s);
    }
  }
  return max;
}
function startPaymentTask(id, payload, options = {}) {
  const persistedTask = paymentTasks.getInternal(id);
  if (process.env.DIPAY_DISABLE_PAYMENT_EXECUTION === '1') {
    const finishDisabledExecution = () => {
      if (persistedTask) {
        paymentTasks.update(id, { state: 'failed', errorCode: '' });
        releaseTaskResources(persistedTask, false, false);
      }
      fingerprintProvider.release(id);
      releaseTaskProxyLease(id);
    };
    if (!persistedTask?.accountResourceId) {
      if (persistedTask) paymentAuditEvent('payment-start', persistedTask, payload);
      finishDisabledExecution();
      return Promise.resolve();
    }
    const account = resources.get('accounts', persistedTask.accountResourceId);
    if (!account) {
      finishDisabledExecution();
      return Promise.resolve();
    }
    return accountContexts
      .load(
        persistedTask.accountResourceId,
        () => loadStoredAccountContext(
          persistedTask.accountResourceId,
          account,
          persistedTask.networkSlot,
          persistedTask.networkProxy
        )
      )
      .then(() => paymentAuditEvent(
        'payment-start',
        persistedTask,
        payload,
        { accountContext: 'cached_or_coalesced' }
      ))
      .finally(finishDisabledExecution);
  }
  if (activePaymentTasks.has(id)) return Promise.resolve();
  activePaymentTasks.add(id);
  return (async () => {
    try {
      let accountContext = null;
      if (persistedTask?.accountResourceId) {
        const account = resources.get('accounts', persistedTask.accountResourceId);
        if (account) {
          accountContext = await accountContexts.load(
            persistedTask.accountResourceId,
            () => loadStoredAccountContext(
              persistedTask.accountResourceId,
              account,
              persistedTask.networkSlot,
              persistedTask.networkProxy
            )
          );
        }
      }
      const result = await runPay(payload, () => {}, {
        ...(accountContext ? { accountContext } : {}),
        onCheckoutCreated: value => paymentTasks.update(id, value),
        onAmount: value => paymentTasks.update(id, value),
        onAccountStatus: value => paymentTasks.update(id, value),
        onStage: value => {
          if (value?.stage === 'confirm_started' && persistedTask?.cardResourceId) {
            resources.recordCardEvent(persistedTask.cardResourceId, id, 'submitted');
          }
          paymentTasks.update(id, value);
        }
      });
      const providerError = result.final?.error || result.error || {};
      const errorCode = providerPaymentErrorCode(providerError);
      const pendingThreeDs = result.state === 'pending_3ds';
      paymentTasks.update(id, {
        state: result.state || (result.ok ? 'succeeded' : 'unknown'),
        amount: result.amount,
        currency: result.currency,
        checkoutSessionId: result.checkoutSessionId,
        processorEntity: result.processorEntity,
        verificationUrl: result.verificationUrl,
        errorCode: result.state === 'failed'
          ? errorCode
          : result.state === 'unknown'
            ? 'payment_result_unknown'
            : '',
        ...(pendingThreeDs ? pendingThreeDsPatch() : {})
      });
      const task = paymentTasks.getInternal(id);
      if (task && pendingThreeDs) {
        if (task.cardResourceId) resources.recordCardEvent(task.cardResourceId, task.id, 'three_ds');
        try {
          if (!threeDsObserver.register(task.id)) {
            console.warn(`[payment-task ${task.id}] three_ds observer registration deferred`);
          }
        } catch {
          console.warn(`[payment-task ${task.id}] three_ds observer registration failed`);
        }
      }
      if (task && result.state === 'succeeded') finishSuccessfulTaskResources(task, { release: !options.holdResourcesOnSuccess });
      if (task && result.state === 'failed') {
        finishFailedTaskResources(task);
      }
    } catch (error) {
      const task = paymentTasks.getInternal(id);
      const confirmationStarted = taskStageAtOrAfterConfirm(task);
      const errorCode = confirmationStarted
        ? 'payment_result_unknown'
        : safePaymentErrorCode(error, { hasProxy: Boolean(payload?.proxy) });
      paymentTasks.update(id, { state: confirmationStarted ? 'unknown' : 'failed', errorCode });
      if (!confirmationStarted && errorCode === 'proxy_connection_failed') {
        markTaskProxyUnhealthy(id);
      }
      if (task && !confirmationStarted) releaseTaskResources(task, false, true);
      console.warn(`[payment-task ${id}] failed: ${errorCode}`);
    } finally {
      activePaymentTasks.delete(id);
      const completed = paymentTasks.getInternal(id);
      if (completed && ['succeeded', 'failed'].includes(completed.state)) {
        fingerprintProvider.release(id);
        releaseTaskProxyLease(id);
      }
    }
  })();
}

function recoverInterruptedPaymentTasks() {
  for (const publicTask of paymentTasks.list()) {
    const task = paymentTasks.getInternal(publicTask.id);
    if (!task || task.state !== 'processing') continue;
    if (taskStageAtOrAfterConfirm(task) || task.checkoutSessionId) {
      paymentTasks.update(task.id, { state: 'unknown', errorCode: 'payment_result_unknown' });
    } else {
      paymentTasks.update(task.id, { state: 'failed', errorCode: 'interrupted' });
      releaseTaskResources(task, false, false);
    }
  }
}

function recoverOrphanedResourceLocks() {
  const unresolved = new Set(
    paymentTasks.list()
      .filter(task => ['processing', 'unknown', 'pending_3ds', 'completing_3ds'].includes(task.state))
      .map(task => task.id)
  );
  return resources.releaseOrphanedLocks(unresolved);
}

function recoverHeldTaskProxyLeases() {
  for (const publicTask of paymentTasks.list()) {
    const task = paymentTasks.getInternal(publicTask.id);
    if (
      !task?.networkProxy
      || !['pending_3ds', 'completing_3ds', 'unknown'].includes(task.state)
    ) {
      continue;
    }
    const ownerId = `recovered:${task.id}`;
    if (proxyLeaseRegistry.acquire(task.networkProxy, ownerId)) {
      activeTaskProxyLeases.set(task.id, { coordinator: null, ownerId });
    } else {
      console.warn(`[payment-task ${task.id}] recovered proxy is already held by another unresolved task`);
    }
  }
}

function taskStageAtOrAfterConfirm(task) {
  return ['confirm_started', 'approve_started', 'polling'].includes(task?.stage);
}

function reconcileTaskCardEvents() {
  for (const publicTask of paymentTasks.list()) {
    const task = paymentTasks.getInternal(publicTask.id);
    if (!task?.cardResourceId) continue;
    if (taskStageAtOrAfterConfirm(task)) {
      resources.recordCardEvent(task.cardResourceId, task.id, 'submitted');
    }
    if (
      task.threeDsDetectedAt
      && (task.state === 'pending_3ds' || task.state === 'completing_3ds')
    ) {
      resources.recordCardEvent(task.cardResourceId, task.id, 'three_ds');
    }
  }
}

function publicBatchRun(run) {
  const tasks = run.taskIds.map(id => paymentTasks.get(id)).filter(Boolean);
  const queued = Math.max(0, run.total - run.taskIds.length);
  const pendingCount = tasks.filter(task => task.state === 'pending_3ds' || task.state === 'completing_3ds').length;
  const unknownCount = tasks.filter(task => task.state === 'unknown').length;
  const processing = queued > 0 || tasks.some(task => task.state === 'processing');
  const paused = pendingCount > 0 || unknownCount > 0;
  return {
    id: run.id,
    state: processing ? 'processing' : (paused ? 'paused' : 'completed'),
    total: run.total,
    queued,
    pausedCards: pendingCount,
    proxy: run.proxyContext?.coordinator.publicStats() || {
      direct: true, total: 0, healthy: 0, unavailable: 0, unchecked: 0, inUse: 0
    },
    waiting: {
      card: Math.max(0, Number(run.waiting?.card) || 0),
      cooldown: Math.max(0, Number(run.waiting?.cooldown) || 0),
      proxy: Math.max(0, Number(run.waiting?.proxy) || 0)
    },
    tasks,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

async function waitForBatchResource(run, kind, promise) {
  if (!run.waiting) run.waiting = { card: 0, cooldown: 0, proxy: 0 };
  run.waiting[kind] = (run.waiting[kind] || 0) + 1;
  run.updatedAt = new Date().toISOString();
  try {
    return await promise;
  } finally {
    run.waiting[kind] = Math.max(0, (run.waiting[kind] || 1) - 1);
    run.updatedAt = new Date().toISOString();
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createBatchProxyContext(_concurrency) {
  const proxies = proxyConfig.snapshot();
  const coordinator = createTaskResourceCoordinator({
    proxies,
    leaseRegistry: proxyLeaseRegistry
  });
  const pending = [];
  for (let index = 0; index < proxies.length; index++) {
    const cached = proxyConfig.cachedHealthAt(index, 120_000);
    if (cached) coordinator.markProxyHealth(index, cached);
    else pending.push(index);
  }
  const state = { done: pending.length === 0 };
  state.promise = pending.length
    ? runPool(pending, Math.min(pending.length, 10), async index => {
        const result = await Promise.race([
          proxyConfig.testAt(index),
          wait(4_000).then(() => ({ ok: false, error: 'proxy_test_timeout' }))
        ]);
        coordinator.markProxyHealth(index, result);
      }).finally(() => { state.done = true; })
    : Promise.resolve();
  return { coordinator, state };
}

async function acquireSingleTaskProxy(proxyContext, ownerId, cursor = 0) {
  let network = proxyContext.coordinator.acquireProxy({ ownerId, cursor });
  while (!network) {
    const stats = proxyContext.coordinator.publicStats();
    if (proxyContext.state.done && stats.healthy === 0) {
      return { network: null, errorCode: 'proxy_unavailable' };
    }
    if (proxyContext.state.done && stats.healthy <= stats.inUse) {
      return { network: null, errorCode: 'proxy_in_use' };
    }
    await proxyContext.coordinator.waitForChange();
    network = proxyContext.coordinator.acquireProxy({ ownerId, cursor });
  }
  return { network, errorCode: '' };
}

function reserveTaskResource(kind, id, taskId) {
  const forcedKind = String(process.env.DIPAY_TEST_RESERVE_CONFLICT_KIND || '');
  if (forcedKind === kind && !forcedReservationConflicts.has(kind)) {
    forcedReservationConflicts.add(kind);
    return false;
  }
  return resources.reserve(kind, id, taskId);
}

function createBatchTask(account, card, address, plan, ordinal, network, proxyContext, proxyOwnerId) {
  const networkProxy = network.proxy;
  let task = paymentTasks.create({
    idempotencyKey: `batch-${crypto.randomUUID()}`,
    email: account.label || '',
    cardLast4: resources.get('cards', card.id)?.number,
    accountResourceId: account.id,
    cardResourceId: card.id,
    addressResourceId: address?.id || '',
    networkSlot: ordinal,
    networkProxy,
    plan,
    state: 'processing'
  });
  const assignedFingerprint = assignTaskFingerprint(task, ordinal);
  task = assignedFingerprint.task;
  registerTaskProxyLease(task.id, proxyContext.coordinator, proxyOwnerId, network.index);
  const refs = [['accounts', account.id], ['cards', card.id], ['addresses', address?.id]].filter(([, id]) => id);
  const reserved = [];
  for (const [kind, id] of refs) {
    if (!reserveTaskResource(kind, id, task.id)) {
      for (const [reservedKind, reservedId] of reserved) {
        releaseResource(reservedKind, reservedId, task.id, { recordUsage: false });
      }
      paymentTasks.update(task.id, { state: 'failed', errorCode: 'resource_in_use' });
      fingerprintProvider.release(task.id);
      releaseTaskProxyLease(task.id);
      auditTestEvent({ type: 'batch-reservation-conflict', taskId: task.id, failedKind: kind });
      return { task, reserved: false, failedKind: kind };
    }
    reserved.push([kind, id]);
  }
  return {
    task,
    reserved: true,
    payload: {
      sessionJson: JSON.stringify(resources.get('accounts', account.id)),
      card: resources.get('cards', card.id),
      address: address?.id ? resources.get('addresses', address.id) : generateAddress('ALL'),
      plan,
      proxy: networkProxy,
      imp: assignedFingerprint.profile?.impersonation || impFor(ordinal)
    }
  };
}

function createBatchFailureTask(account, plan, slot, errorCode) {
  const task = paymentTasks.create({
    idempotencyKey: `batch-${crypto.randomUUID()}`,
    email: account.label || '',
    accountResourceId: account.id,
    networkSlot: slot,
    plan,
    state: 'failed',
    errorCode
  });
  return task;
}

async function startBatchRun(run, accounts, cards, addresses, concurrency, plan, proxyContext) {
  const cardIds = cards.map(card => card.id);
  const addressIds = addresses.map(address => address.id);
  let nextAccount = 0;
  let cardCursor = 0, addressCursor = 0, proxyCursor = 0;
  const pickAvailable = (kind, ids, cursor, excluded = new Set()) => {
    const views = new Map(resources.list(kind).map(item => [item.id, item]));
    for (let offset = 0; offset < ids.length; offset++) {
      const id = ids[(cursor + offset) % ids.length];
      if (excluded.has(id)) continue;
      if (!['in_use', 'cooldown', 'insufficient_funds'].includes(views.get(id)?.usage?.state)) return { item: views.get(id), next: (cursor + offset + 1) % ids.length };
    }
    return null;
  };
  await Promise.all(Array.from({ length: concurrency }, async (_, slot) => {
    while (nextAccount < accounts.length) {
      const ordinal = nextAccount++;
      const account = accounts[ordinal];
      const attemptedCards = new Set();
      const attemptedAddresses = new Set();
      let accountTaskCount = 0;
      let useTemporaryAddress = false;
      let temporaryAddressFailures = 0;
      const hardAttemptLimit = Math.max(
        1,
        cardIds.length + addressIds.length + proxyContext.coordinator.snapshot().length + 3
      );
      for (let attempt = 0; attempt < hardAttemptLimit; attempt++) {
        const cardPick = pickAvailable('cards', cardIds, cardCursor, attemptedCards);
        const persistedAddressPick = !useTemporaryAddress && addressIds.length
          ? pickAvailable('addresses', addressIds, addressCursor, attemptedAddresses)
          : null;
        const addressPick = persistedAddressPick || { item: null, next: addressCursor };
        if (addressIds.length && !persistedAddressPick) useTemporaryAddress = true;
        if (!cardPick) {
          const currentCards = resources.list('cards').filter(card => cardIds.includes(card.id));
          const states = currentCards.map(card => card.usage?.state);
          const cooldownDelays = currentCards
            .filter(card => !attemptedCards.has(card.id) && card.usage?.state === 'cooldown')
            .map(card => Date.parse(card.usage?.cooldownUntil || '') - Date.now())
            .filter(delay => Number.isFinite(delay) && delay > 0);
          if (cooldownDelays.length) {
            await waitForBatchResource(run, 'cooldown', wait(Math.min(...cooldownDelays) + 10));
            attempt--;
            continue;
          }
          if (states.includes('in_use') && activePaymentTasks.size) {
            await waitForBatchResource(run, 'card', resourceWakeSignal.wait());
            attempt--;
            continue;
          }
          run.pausedCards = states.filter(state => state === 'insufficient_funds').length;
          if (!accountTaskCount) {
            const failed = createBatchFailureTask(account, plan, slot, 'resource_unavailable');
            run.taskIds.push(failed.id);
            run.updatedAt = new Date().toISOString();
          }
          break;
        }
        cardCursor = cardPick.next;
        addressCursor = addressPick.next;
        const proxyOwnerId = `${run.id}:${ordinal}:${attempt}`;
        let network = proxyContext.coordinator.acquireProxy({
          ownerId: proxyOwnerId,
          cursor: proxyCursor
        });
        while (!network) {
          const stats = proxyContext.coordinator.publicStats();
          if (proxyContext.state.done && stats.healthy === 0) break;
          await waitForBatchResource(run, 'proxy', proxyContext.coordinator.waitForChange());
          network = proxyContext.coordinator.acquireProxy({
            ownerId: proxyOwnerId,
            cursor: proxyCursor
          });
        }
        if (!network) {
          if (!accountTaskCount) {
            const failed = createBatchFailureTask(account, plan, ordinal, 'proxy_unavailable');
            run.taskIds.push(failed.id);
            run.updatedAt = new Date().toISOString();
          }
          break;
        }
        proxyCursor = network.nextCursor;
        const job = createBatchTask(
          account,
          cardPick.item,
          addressPick.item,
          plan,
          ordinal,
          network,
          proxyContext,
          proxyOwnerId
        );
        run.taskIds.push(job.task.id); accountTaskCount++; run.updatedAt = new Date().toISOString();
        if (!job.reserved) {
          if (job.failedKind === 'accounts') break;
          if (job.failedKind === 'cards') {
            attemptedCards.add(cardPick.item.id);
            continue;
          }
          if (job.failedKind === 'addresses') {
            useTemporaryAddress = true;
            continue;
          }
          break;
        }
        attemptedCards.add(cardPick.item.id);
        await startPaymentTask(job.task.id, job.payload, { holdResourcesOnSuccess: true });
        const task = paymentTasks.getInternal(job.task.id);
        if (task?.state === 'succeeded') {
          releaseResource('accounts', task.accountResourceId, task.id, { paid: true });
          releaseResource('addresses', task.addressResourceId, task.id, { paid: true });
          resources.recordPaidUsage('cards', task.cardResourceId, task.id);
          releaseResource('cards', task.cardResourceId, task.id, { cooldownMs: 30_000 });
          run.updatedAt = new Date().toISOString();
          break;
        }
        const action = paymentFailureAction(task);
        if (action === 'next_card') continue;
        if (action === 'next_address') {
          attemptedCards.delete(cardPick.item.id);
          if (addressPick.item?.id) attemptedAddresses.add(addressPick.item.id);
          else temporaryAddressFailures++;
          useTemporaryAddress = attemptedAddresses.size >= addressIds.length;
          if (temporaryAddressFailures < 2) continue;
        }
        if (action === 'next_proxy') {
          attemptedCards.delete(cardPick.item.id);
          proxyContext.coordinator.markProxyHealth(network.index, {
            ok: false,
            error: 'proxy_connection_failed'
          });
          continue;
        }
        if (action === 'reconcile') run.pausedCards++;
        break;
      }
    }
  }));
  run.state = run.pausedCards ? 'paused' : 'completed';
  run.updatedAt = new Date().toISOString();
}

function paymentPayloadIsPresent(body) {
  return body && typeof body.sessionJson === 'string' && body.sessionJson.trim() && body.card && body.address;
}

function accountStatusNeedsFreshCheck(status = {}) {
  return !['free', 'active', 'invalid'].includes(String(status?.state || '').trim().toLowerCase());
}

const server = http.createServer({ maxHeaderSize: 65536 }, async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf-8'));
    return;
  }
  if (u.pathname === '/reference-ui.css' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(fs.readFileSync(path.join(PUBLIC, 'reference-ui.css'), 'utf-8'));
    return;
  }

  const resourceRoute = u.pathname.match(/^\/api\/resources\/(accounts|cards|addresses)\/(import|use)$/);
  if (resourceRoute && req.method === 'POST') {
    const [, kind, action] = resourceRoute;
    try {
      const body = await readJsonBody(req);
      if (action === 'use') {
        const item = resources.get(kind, String(body.id || ''));
        if (!item) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'resource not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(item));
        return;
      }
      const file = body.file;
      if (!file || typeof file.name !== 'string' || typeof file.text !== 'string') throw new Error('file name and text are required');
      if (kind === 'accounts') {
        const result = await importAccountFile(file);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      const parsed = parseResourceFile(kind, file);
      let added = 0, duplicate = 0;
      for (const [index, record] of parsed.records.entries()) {
        const saved = resources.add(kind, record, { file: file.name, line: parsed.lines?.[index] ?? null });
        if (saved.status === 'added') added++;
        else duplicate++;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ file: file.name, added, duplicate, errors: parsed.errors }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'invalid import request' }));
    }
    return;
  }

  if (u.pathname === '/api/resources/accounts/detect-import' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const result = await importAccountFile({
        name: 'pasted-account.txt',
        text: String(body.text || '')
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'account detection failed' }));
    }
    return;
  }

  const resourceClearRoute = u.pathname.match(/^\/api\/resources\/(accounts|cards|addresses)\/clear$/);
  if (resourceClearRoute && req.method === 'POST') {
    const kind = resourceClearRoute[1];
    if (resources.list(kind).some(item => item.usage?.state === 'in_use')) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'locked resources cannot be cleared' }));
      return;
    }
    const cleared = resources.clear(kind);
    if (kind === 'accounts') accountContexts.clear();
    if (cleared) resourceWakeSignal.notify(`${kind}_cleared`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cleared }));
    return;
  }

  const resourceDeleteRoute = u.pathname.match(/^\/api\/resources\/(accounts|cards|addresses)\/((?:accounts|cards|addresses)_[a-f0-9]{24})$/);
  if (resourceDeleteRoute && req.method === 'DELETE') {
    const [, kind, id] = resourceDeleteRoute;
    const item = resources.list(kind).find(value => value.id === id);
    if (item?.usage?.state === 'in_use') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'locked resource cannot be deleted' }));
      return;
    }
    const deleted = resources.remove(kind, id);
    if (deleted && kind === 'accounts') accountContexts.invalidate(id);
    if (deleted) resourceWakeSignal.notify(`${kind}_removed`);
    res.writeHead(deleted ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted }));
    return;
  }

  const accountCheckRoute = u.pathname.match(/^\/api\/resources\/accounts\/(accounts_[a-f0-9]{24})\/check$/);
  if (accountCheckRoute && req.method === 'POST') {
    if (!resources.get('accounts', accountCheckRoute[1])) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'account resource not found' }));
    } else {
      if (!activeAccountChecks.has(accountCheckRoute[1])) {
        accountContexts.invalidate(accountCheckRoute[1]);
      }
      startAccountStatusCheck(accountCheckRoute[1]);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ checking: true }));
    }
    return;
  }

  const cardRestoreRoute = u.pathname.match(/^\/api\/resources\/cards\/(cards_[a-f0-9]{24})\/restore$/);
  if (cardRestoreRoute && req.method === 'POST') {
    const restored = resources.restoreCard(cardRestoreRoute[1]);
    if (restored) resourceWakeSignal.notify('card_restored');
    res.writeHead(restored ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ restored }));
    return;
  }

  if (u.pathname === '/api/accounts' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resources.list('accounts')));
    return;
  }
  if (u.pathname === '/api/cards' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resources.list('cards')));
    return;
  }
  if (u.pathname === '/api/addresses' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resources.list('addresses')));
    return;
  }

  if (req.method === 'POST' && [
    '/api/accounts/import',
    '/api/cards/import',
    '/api/addresses/import',
    '/api/accounts/clear',
    '/api/cards/clear',
    '/api/addresses/clear'
  ].includes(u.pathname)) {
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'use /api/resources/:kind/import' }));
    return;
  }

  if (u.pathname === '/api/accounts' && req.method === 'GET') {
    const files = fs.existsSync(ACCOUNTS_DIR) ? accountOrder(ACCOUNTS_DIR) : [];
    const list = files.map(f => {
      const j = readJson(path.join(ACCOUNTS_DIR, f), {});
      let raw = '';
      try { raw = fs.readFileSync(path.join(ACCOUNTS_DIR, f), 'utf-8'); } catch {}
      return { file: f, email: j?.user?.email || f, raw };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  if (u.pathname === '/api/accounts/import' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { sessions } = JSON.parse(body);
        if (!Array.isArray(sessions) || !sessions.length) throw new Error('空');
        fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
        const saved = [], failed = [];
        const { resolveToken } = await import('./browser.js');
        // 并行解析/兑换，按序号分配不同代理与 TLS 指纹；_seq 记录粘贴顺序供配对使用
        let seq = maxSeq(ACCOUNTS_DIR);
        await Promise.all(sessions.map(async (sj, i) => {
          const raw = typeof sj === 'string' ? sj : JSON.stringify(sj);
          let email = 'account-' + (i + 1);
          try {
            const r = await resolveToken(raw, { proxy: proxyFor(i), imp: impFor(i) });
            if (r.email) email = r.email;
            const obj = typeof sj === 'object' ? { ...sj } : { accessToken: r.token, user: { email: r.email } };
            obj._seq = seq + i + 1;
            fs.writeFileSync(path.join(ACCOUNTS_DIR, email.replace(/[^\w.@+-]/g, '_') + '.json'), JSON.stringify(obj, null, 2));
            saved.push(email);
          } catch (e) {
            failed.push({ raw: raw.slice(0, 40), error: e.message || String(e) });
          }
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ saved: saved.length, list: saved, failed }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '解析失败' }));
      }
    });
    return;
  }

  if (u.pathname === '/api/accounts/clear' && req.method === 'POST') {
    if (resources.list('accounts').some(item => item.usage?.state === 'in_use')) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'locked resources cannot be cleared' }));
      return;
    }
    let n = 0;
    if (fs.existsSync(ACCOUNTS_DIR)) {
      for (const f of fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json'))) {
        fs.unlinkSync(path.join(ACCOUNTS_DIR, f)); n++;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cleared: n }));
    return;
  }

  if (u.pathname === '/api/cards' && req.method === 'GET') {
    const files = fs.existsSync(CARDS_DIR) ? natSort(fs.readdirSync(CARDS_DIR).filter(f => f.endsWith('.json'))) : [];
    const list = files.map(f => {
      const c = readJson(path.join(CARDS_DIR, f), {});
      const num = String(c.number || '');
      return { file: f, number: num, exp: c.exp || '', cvc: c.cvc || '', name: c.name || '', masked: num ? '…' + num.slice(-4) : '' };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  if (u.pathname === '/api/cards/import' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        const cards = parseCards(text);
        if (!cards.length) throw new Error('没有识别到有效卡信息');
        fs.mkdirSync(CARDS_DIR, { recursive: true });
        // 已有卡号 → 文件名，用于去重覆盖
        const existing = new Map();
        if (fs.existsSync(CARDS_DIR)) {
          for (const f of fs.readdirSync(CARDS_DIR).filter(f => f.endsWith('.json'))) {
            const c = readJson(path.join(CARDS_DIR, f), null);
            if (c?.number) existing.set(String(c.number), f);
          }
        }
        const saved = [], failed = [];
        let cardIdx = nextIndex(CARDS_DIR, /^card-\w+-(\d+)\.json$/);
        for (const c of cards) {
          try {
            const card = validateCard(c);
            if (!card.name) card.name = randomName();
            const fname = existing.get(card.number) || `card-${card.number.slice(-4)}-${cardIdx++}.json`;
            fs.writeFileSync(path.join(CARDS_DIR, fname), JSON.stringify(card, null, 2));
            existing.set(card.number, fname);
            saved.push(card.number.slice(-4));
          } catch (e) {
            failed.push({ raw: JSON.stringify(c).slice(0, 60), error: e.message });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ saved: saved.length, list: saved, failed }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || '解析失败' }));
      }
    });
    return;
  }

  if (u.pathname === '/api/cards/clear' && req.method === 'POST') {
    if (resources.list('cards').some(item => item.usage?.state === 'in_use')) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'locked resources cannot be cleared' }));
      return;
    }
    let n = 0;
    if (fs.existsSync(CARDS_DIR)) {
      for (const f of fs.readdirSync(CARDS_DIR).filter(f => f.endsWith('.json'))) {
        fs.unlinkSync(path.join(CARDS_DIR, f)); n++;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cleared: n }));
    return;
  }

  if (u.pathname === '/api/addresses' && req.method === 'GET') {
    const files = fs.existsSync(ADDR_DIR) ? natSort(fs.readdirSync(ADDR_DIR).filter(f => f.endsWith('.json'))) : [];
    const list = files.map(f => {
      const a = readJson(path.join(ADDR_DIR, f), {});
      const label = [a.line1, a.city, a.country].filter(Boolean).join(', ');
      return { file: f, ...a, label };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  if (u.pathname === '/api/addresses/import' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        const addrs = parseAddresses(text);
        if (!addrs.length) throw new Error('没有识别到有效地址');
        fs.mkdirSync(ADDR_DIR, { recursive: true });
        // 已有地址（按内容）→ 文件名，用于去重覆盖
        const existing = new Map();
        for (const f of fs.readdirSync(ADDR_DIR).filter(f => f.endsWith('.json'))) {
          const a = readJson(path.join(ADDR_DIR, f), null);
          if (a) existing.set(JSON.stringify(a), f);
        }
        const saved = [], failed = [];
        let addrIdx = nextIndex(ADDR_DIR, /^addr-(\d+)\.json$/);
        for (const a of addrs) {
          try {
            const addr = validateAddress(a);
            const key = JSON.stringify(addr);
            const fname = existing.get(key) || `addr-${addrIdx++}.json`;
            fs.writeFileSync(path.join(ADDR_DIR, fname), JSON.stringify(addr, null, 2));
            existing.set(key, fname);
            saved.push(addr.city);
          } catch (e) {
            failed.push({ raw: JSON.stringify(a).slice(0, 60), error: e.message });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ saved: saved.length, list: saved, failed }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || '解析失败' }));
      }
    });
    return;
  }

  if (u.pathname === '/api/addresses/temporary' && req.method === 'POST') {
    try {
      const address = generateAddress('ALL');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        line1: address.line1, city: address.city, state: address.state,
        zip: address.zip, country: address.country, temporary: true
      }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'temporary address generation failed' }));
    }
    return;
  }

  if (u.pathname === '/api/addresses/generate' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { n = 10, state = 'ALL' } = JSON.parse(body || '{}');
        const list = generateBatch(n, state);
        fs.mkdirSync(ADDR_DIR, { recursive: true });
        const existing = new Map();
        for (const f of fs.readdirSync(ADDR_DIR).filter(f => f.endsWith('.json'))) {
          const a = readJson(path.join(ADDR_DIR, f), null);
          if (a) existing.set(JSON.stringify(a), f);
        }
        let saved = 0;
        let addrIdx = nextIndex(ADDR_DIR, /^addr-(\d+)\.json$/);
        for (const a of list) {
          const key = JSON.stringify(a);
          const fname = existing.get(key) || `addr-${addrIdx++}.json`;
          fs.writeFileSync(path.join(ADDR_DIR, fname), JSON.stringify(a, null, 2));
          existing.set(key, fname);
          saved++;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ saved, sample: list[0] }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || '生成失败' }));
      }
    });
    return;
  }

  if (u.pathname === '/api/addresses/clear' && req.method === 'POST') {
    if (resources.list('addresses').some(item => item.usage?.state === 'in_use')) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'locked resources cannot be cleared' }));
      return;
    }
    let n = 0;
    if (fs.existsSync(ADDR_DIR)) {
      for (const f of fs.readdirSync(ADDR_DIR).filter(f => f.endsWith('.json'))) {
        fs.unlinkSync(path.join(ADDR_DIR, f)); n++;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cleared: n }));
    return;
  }

  if (u.pathname === '/api/proxy-config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(proxyConfig.publicView()));
    return;
  }
  if (u.pathname === '/api/fingerprint-provider' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...fingerprintProvider.publicView(),
      order: 'top_to_bottom',
      lease: 'soft',
      integrationReady: true
    }));
    return;
  }
  if (u.pathname === '/api/proxy-config' && req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const result = proxyConfig.replace(body.text ?? body.proxies ?? '');
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid_proxy_config' }));
    }
    return;
  }
  if (u.pathname === '/api/proxy-config' && req.method === 'DELETE') {
    const index = u.searchParams.get('index');
    const result = index === null ? proxyConfig.clear() : proxyConfig.remove(index);
    res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
  if (u.pathname === '/api/proxy-config/test' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    const result = await proxyConfig.testAt(body.index);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (u.pathname === '/api/health') {
    const proxy = proxyConfig.publicView();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, browser: 'cffi', proxyPool: proxy.count, proxy: proxy.items[0]?.label || null }));
    return;
  }
  // 过盾设置：CapSolver key / CDP 浏览器地址，存 config/solver.json（环境变量优先）
  const CONFIG_SOLVER = path.join(ROOT, '..', 'config', 'solver.json');
  if (u.pathname === '/api/solver' && req.method === 'GET') {
    const { solverConfig } = await import('./solver.js');
    const cfg = solverConfig();
    const file = readJson(CONFIG_SOLVER, {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      apiKeySet: !!cfg.apiKey,
      apiKeyMasked: cfg.apiKey ? cfg.apiKey.slice(0, 8) + '…' + cfg.apiKey.slice(-4) : '',
      apiKeyEnv: !!(process.env.SOLVER_API_KEY || '').trim(),
      browserWs: cfg.browserWs,
      browserWsEnv: !!(process.env.BROWSER_WS_ENDPOINT || '').trim(),
      chromePath: cfg.chromePath,
      file: { apiKeySet: !!(file.apiKey || '').trim(), browserWs: file.browserWs || '' }
    }));
    return;
  }
  if (u.pathname === '/api/solver' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const d = JSON.parse(body || '{}');
        const cur = readJson(CONFIG_SOLVER, {});
        if (!(process.env.SOLVER_API_KEY || '').trim() && typeof d.apiKey === 'string') cur.apiKey = d.apiKey.trim();
        if (!(process.env.BROWSER_WS_ENDPOINT || '').trim() && typeof d.browserWs === 'string') cur.browserWs = d.browserWs.trim();
        writeJsonAtomic(CONFIG_SOLVER, cur);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || '保存失败' }));
      }
    });
    return;
  }
  if (u.pathname === '/api/solver' && req.method === 'DELETE') {
    try {
      const body = await readJsonBody(req);
      const cur = readJson(CONFIG_SOLVER, {});
      const field = String(body.field || 'all');
      if (field === 'apiKey' || field === 'all') delete cur.apiKey;
      if (field === 'browserWs' || field === 'all') delete cur.browserWs;
      writeJsonAtomic(CONFIG_SOLVER, cur);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'clear_failed' }));
    }
    return;
  }
  if (u.pathname === '/api/solver/test' && req.method === 'POST') {
    (async () => {
      try {
        const { solverConfig } = await import('./solver.js');
        const key = solverConfig().apiKey;
        if (!key) throw new Error('未配置 CapSolver API Key');
        const r = await fetch('https://api.capsolver.com/getBalance', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: key })
        });
        const d = await r.json();
        if (d.errorId) throw new Error(d.errorCode || '验证失败');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, balance: d.balance }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || '验证失败' }));
      }
    })();
    return;
  }
  if (u.pathname === '/api/defaults') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ address: readJson(CONFIG_ADDR, {}) }));
    return;
  }
  if (u.pathname === '/api/pay') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end(JSON.stringify({ error: 'use POST /api/payment-tasks' }));
    return;
  }
  if (u.pathname === '/api/batch-pay') {
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'use /api/payment-tasks/batch' }));
    return;
  }
  if (u.pathname === '/api/link' || u.pathname === '/api/batch-links') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end(JSON.stringify({ error: 'use POST /api/links or /api/links/batch' }));
    return;
  }
  if (u.pathname === '/api/links' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const accountResourceId = String(body.accountResourceId || '');
      const account = accountResourceId ? resources.get('accounts', accountResourceId) : null;
      if (accountResourceId && !account) throw new Error('selected accounts resource not found');
      const sessionJson = account ? JSON.stringify(account) : String(body.sessionJson || '').trim();
      if (!sessionJson) throw new Error('account session is required');
      const payload = {
        sessionJson,
        plan: String(body.plan || 'chatgptpro'),
        proxy: proxyFor(0),
        imp: impFor(0)
      };
      if (process.env.DIPAY_DISABLE_PAYMENT_EXECUTION === '1') {
        auditTestEvent({ type: 'link-start', email: emailFromSession(sessionJson) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: 'disabled', links: {} }));
        return;
      }
      const links = await runLink(payload, () => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'succeeded', links }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'link generation failed' }));
    }
    return;
  }
  if (u.pathname === '/api/links/batch' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const concurrency = Math.max(1, Math.min(10, Number.parseInt(body.concurrency, 10) || 1));
      const plan = String(body.plan || 'chatgptpro');
      const accounts = resources.list('accounts').filter(item => item.payment?.state !== 'completed');
      const results = await runPool(accounts, concurrency, async (view, index) => {
        const account = resources.get('accounts', view.id);
        if (!account) return { accountId: view.id, email: view.label, ok: false, errorCode: 'account_resource_not_found' };
        if (process.env.DIPAY_DISABLE_PAYMENT_EXECUTION === '1') {
          auditTestEvent({ type: 'link-start', id: view.id, email: view.label });
          return { accountId: view.id, email: view.label, ok: true, links: {} };
        }
        try {
          const links = await runLink({
            sessionJson: JSON.stringify(account),
            plan,
            proxy: proxyFor(index),
            imp: impFor(index)
          }, () => {});
          return { accountId: view.id, email: view.label, ok: true, links };
        } catch (error) {
          return {
            accountId: view.id,
            email: view.label,
            ok: false,
            errorCode: safePaymentErrorCode(error, { hasProxy: Boolean(proxyFor(index)) })
          };
        }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: results.length, results }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'batch link generation failed' }));
    }
    return;
  }
  if (u.pathname === '/api/payment-tasks' && req.method === 'GET') {
    const state = String(u.searchParams.get('state') || '');
    const limit = Math.max(1, Math.min(1000, Number.parseInt(u.searchParams.get('limit'), 10) || 100));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(paymentTasks.list({ state, limit })));
    return;
  }
  if (u.pathname === '/api/payment-tasks/succeeded' && req.method === 'DELETE') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cleared: paymentTasks.clearSucceeded() }));
    return;
  }
  if (u.pathname === '/api/payment-tasks/terminal' && req.method === 'DELETE') {
    const state = String(u.searchParams.get('state') || 'all');
    const states = state === 'all' ? ['succeeded', 'failed'] : [state];
    const cleared = paymentTasks.clearTerminal(states);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cleared }));
    return;
  }
  if (u.pathname === '/api/payment-tasks' && req.method === 'POST') {
    let provisionalProxy = null;
    try {
      const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
      if (idempotencyKey.length < 16 || idempotencyKey.length > 200) throw new Error('valid Idempotency-Key header is required');
      const body = await readJsonBody(req);
      const accountResourceId = String(body.accountResourceId || '');
      const cardResourceId = String(body.cardResourceId || '');
      const addressResourceId = String(body.addressResourceId || '');
      const targetPlan = String(body.plan || 'chatgptpro');
      const selectedResources = [
        ['accounts', accountResourceId],
        ['cards', cardResourceId],
        ['addresses', addressResourceId]
      ].filter(([, id]) => id);
      for (const [kind, id] of selectedResources) {
        if (!resources.get(kind, id)) throw new Error(`selected ${kind} resource not found`);
      }
      const payload = {
        ...body,
        sessionJson: accountResourceId ? JSON.stringify(resources.get('accounts', accountResourceId)) : body.sessionJson,
        card: cardResourceId ? resources.get('cards', cardResourceId) : body.card,
        address: addressResourceId
          ? resources.get('addresses', addressResourceId)
          : (body.address || generateAddress('ALL')),
        plan: targetPlan,
        imp: impFor(0)
      };
      if (!paymentPayloadIsPresent(payload)) throw new Error('session, card, and address are required');
      if (accountResourceId) {
        const account = resources.list('accounts').find(item => item.id === accountResourceId);
        if (account?.payment?.state === 'completed') throw new Error('selected account is already completed');
        if (!accountStatusNeedsFreshCheck(account?.accountStatus)) {
          try {
            assertAccountCanSubscribe(account?.accountStatus, targetPlan);
          } catch (error) {
            const errorCode = safePaymentErrorCode(error);
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'selected account is not eligible for payment', errorCode }));
            return;
          }
        }
      }
      const proxyContext = createBatchProxyContext(1);
      const proxyOwnerId = `single:${idempotencyKey}`;
      const acquired = await acquireSingleTaskProxy(proxyContext, proxyOwnerId, singleProxyCursor);
      if (!acquired.network) {
        proxyContext.coordinator.close();
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no usable proxy is currently available', errorCode: acquired.errorCode }));
        return;
      }
      provisionalProxy = { proxyContext, proxyOwnerId };
      const networkProxy = acquired.network.proxy;
      singleProxyCursor = acquired.network.nextCursor;
      payload.proxy = networkProxy;
      let task = paymentTasks.create({
        idempotencyKey,
        email: accountResourceId
          ? resources.list('accounts').find(item => item.id === accountResourceId)?.label || ''
          : emailFromSession(payload.sessionJson),
        cardLast4: payload.card.number,
        accountResourceId,
        cardResourceId,
        addressResourceId,
        networkSlot: 0,
        networkProxy,
        plan: targetPlan,
        state: 'processing'
      });
      if (!task.reused) {
        registerTaskProxyLease(task.id, proxyContext.coordinator, proxyOwnerId, acquired.network.index);
        provisionalProxy = null;
        const assignedFingerprint = assignTaskFingerprint(task, singleFingerprintCursor++);
        task = assignedFingerprint.task;
        payload.imp = assignedFingerprint.profile?.impersonation || payload.imp;
        const reserved = [];
        for (const [kind, id] of selectedResources) {
          if (!resources.reserve(kind, id, task.id)) {
            for (const [reservedKind, reservedId] of reserved) {
              releaseResource(reservedKind, reservedId, task.id, { recordUsage: false });
            }
            fingerprintProvider.release(task.id);
            releaseTaskProxyLease(task.id);
            const failed = paymentTasks.update(task.id, { state: 'failed', errorCode: 'resource_in_use' });
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(failed));
            return;
          }
          reserved.push([kind, id]);
        }
        startPaymentTask(task.id, payload);
      } else {
        proxyContext.coordinator.releaseProxy(proxyOwnerId);
        proxyContext.coordinator.close();
        provisionalProxy = null;
      }
      res.writeHead(task.reused ? 200 : 202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    } catch (error) {
      if (provisionalProxy) {
        provisionalProxy.proxyContext.coordinator.releaseProxy(provisionalProxy.proxyOwnerId);
        provisionalProxy.proxyContext.coordinator.close();
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'invalid payment task request' }));
    }
    return;
  }

  if (u.pathname === '/api/payment-tasks/batch' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const concurrency = Math.max(1, Math.min(10, Number.parseInt(body.concurrency, 10) || 1));
      const targetPlan = String(body.plan || 'chatgptpro');
      const accounts = resources.list('accounts').filter(item => {
        if (item.payment?.state === 'completed' || item.usage?.state === 'in_use') return false;
        if (accountStatusNeedsFreshCheck(item.accountStatus)) return true;
        try {
          assertAccountCanSubscribe(item.accountStatus, targetPlan);
          return true;
        } catch {
          return false;
        }
      });
      const cards = resources.list('cards').filter(item => !['in_use', 'insufficient_funds'].includes(item.usage?.state));
      const addresses = resources.list('addresses').filter(item => item.usage?.state !== 'in_use');
      if (!accounts.length) throw new Error('no available accounts for batch payment');
      if (!cards.length) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'batch payment requires at least one available card', available: { accounts: accounts.length, cards: cards.length, addresses: addresses.length } }));
        return;
      }
      const proxyContext = createBatchProxyContext(concurrency);
      const run = {
        id: crypto.randomUUID(),
        state: 'processing',
        total: accounts.length,
        taskIds: [],
        pausedCards: 0,
        waiting: { card: 0, cooldown: 0, proxy: 0 },
        proxyContext,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      activeBatchRuns.set(run.id, run);
      void startBatchRun(run, accounts, cards, addresses, concurrency, targetPlan, proxyContext)
        .catch(() => {
          run.state = 'completed';
          run.updatedAt = new Date().toISOString();
        })
        .finally(() => {
          proxyContext.coordinator.close();
          const cleanup = setTimeout(() => activeBatchRuns.delete(run.id), 10 * 60_000);
          cleanup.unref?.();
        });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...publicBatchRun(run), concurrency }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'invalid batch payment request' }));
    }
    return;
  }

  const batchRoute = u.pathname.match(/^\/api\/payment-batches\/([0-9a-f-]{36})$/i);
  if (batchRoute && req.method === 'GET') {
    const run = activeBatchRuns.get(batchRoute[1]);
    if (!run) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payment batch not found' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(publicBatchRun(run)));
    }
    return;
  }

  const threeDsDetailRoute = u.pathname.match(/^\/api\/payment-tasks\/([0-9a-f-]{36})\/three-ds-detail$/i);
  if (threeDsDetailRoute && req.method === 'GET') {
    const internal = paymentTasks.getInternal(threeDsDetailRoute[1]);
    if (!internal || !internal.threeDsDetectedAt) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '3ds task not found' }));
      return;
    }
    const account = resources.list('accounts').find(item => item.id === internal.accountResourceId) || null;
    const card = resources.list('cards').find(item => item.id === internal.cardResourceId) || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ task: paymentTasks.get(internal.id), account, card }));
    return;
  }

  const taskCancelRoute = u.pathname.match(/^\/api\/payment-tasks\/([0-9a-f-]{36})\/cancel$/i);
  if (taskCancelRoute && req.method === 'POST') {
    const failed = paymentTasks.failUnresolved(taskCancelRoute[1], 'user_cancelled');
    if (!failed) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payment task is not cancellable' }));
      return;
    }
    threeDsObserver.stop(failed.id);
    finishFailedTaskResources(failed);
    fingerprintProvider.release(failed.id);
    releaseTaskProxyLease(failed.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(paymentTasks.get(failed.id)));
    return;
  }

  const taskRoute = u.pathname.match(/^\/api\/payment-tasks\/([0-9a-f-]{36})(?:\/(recheck))?$/i);
  if (taskRoute && req.method === 'GET' && !taskRoute[2]) {
    const task = paymentTasks.get(taskRoute[1]);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payment task not found' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    }
    return;
  }

  if (taskRoute && req.method === 'POST' && taskRoute[2] === 'recheck') {
    try {
      const task = paymentTasks.getInternal(taskRoute[1]);
      if (!task) throw new Error('payment task not found');
      if (task.state === 'pending_3ds' || task.state === 'completing_3ds') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(paymentTasks.get(task.id)));
        return;
      }
      if (!task.checkoutSessionId || !task.processorEntity) throw new Error('payment task cannot be rechecked yet');
      const body = await readJsonBody(req);
      const networkSlot = Number.isSafeInteger(task.networkSlot) && task.networkSlot >= 0 ? task.networkSlot : 0;
      const network = { proxy: task.networkProxy || proxyFor(networkSlot), imp: impFor(networkSlot) };
      const account = task.accountResourceId ? resources.get('accounts', task.accountResourceId) : null;
      if (task.accountResourceId && !account) throw new Error('selected accounts resource not found');
      const sessionJson = account ? JSON.stringify(account) : String(body.sessionJson || '').trim();
      if (process.env.DIPAY_DISABLE_PAYMENT_EXECUTION === '1') {
        paymentAuditEvent('payment-recheck', task, { sessionJson, ...network });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(paymentTasks.get(task.id)));
        return;
      }
      const { token } = await resolveToken(sessionJson, network);
      const status = await cg.getSessionStatus(token, task.processorEntity, task.checkoutSessionId, network);
      let state = status.json?.status === 'complete' ? 'succeeded' : 'unknown';
      let errorCode = '';
      let verificationUrl = '';
      if (state !== 'succeeded' && status.json?.publishable_key) {
        const polled = await stripe.pollSession(
          task.checkoutSessionId,
          status.json.publishable_key,
          network.proxy
        );
        const providerError = paymentErrorFromPayload(polled.j);
        const classified = classifyPaymentStatus(polled.j);
        if (providerError && (
          isPrepaymentInvoiceMismatch(polled.j)
          || classifyProviderPaymentError(providerError) === 'failed'
        )) {
          state = 'failed';
          errorCode = providerPaymentErrorCode(providerError);
        } else if (classified.state === 'succeeded') {
          state = 'succeeded';
        } else if (classified.state === 'pending_3ds') {
          state = 'pending_3ds';
          verificationUrl = classified.verificationUrl || '';
        }
      }
      if (state === 'unknown' && task.state === 'pending_3ds') {
        state = 'pending_3ds';
        verificationUrl = task.verificationUrl || '';
      }
      const newlyDetectedThreeDs = state === 'pending_3ds' && !task.threeDsDetectedAt;
      const updated = paymentTasks.update(task.id, {
        state,
        verificationUrl,
        errorCode: state === 'succeeded' ? '' : (errorCode || task.errorCode),
        ...(newlyDetectedThreeDs ? pendingThreeDsPatch() : {})
      });
      if (newlyDetectedThreeDs) {
        const pendingTask = paymentTasks.getInternal(task.id);
        if (pendingTask?.cardResourceId) {
          resources.recordCardEvent(pendingTask.cardResourceId, pendingTask.id, 'three_ds');
        }
        threeDsObserver.register(task.id);
      }
      if (state === 'succeeded') finishSuccessfulTaskResources(paymentTasks.getInternal(task.id));
      if (state === 'failed') {
        const internal = paymentTasks.getInternal(task.id);
        finishFailedTaskResources(internal);
      }
      if (state === 'succeeded' || state === 'failed') {
        fingerprintProvider.release(task.id);
        releaseTaskProxyLease(task.id);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
    } catch (error) {
      res.writeHead(error.message === 'payment task not found' ? 404 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'payment recheck failed' }));
    }
    return;
  }

  res.writeHead(404); res.end();
});
reconcileTaskCardEvents();
recoverInterruptedPaymentTasks();
recoverOrphanedResourceLocks();
recoverHeldTaskProxyLeases();
threeDsObserver.recover();
server.on('close', () => threeDsObserver.close());
server.listen(PORT, HOST, () => {
  console.log(`dipay 已启动 → http://${HOST}:${PORT}  (browser: ${'cffi'})`);
  const accountsToCheck = resources.list('accounts').filter(account => account.payment?.state !== 'completed');
  void runPool(accountsToCheck, 3, (account, index) => startAccountStatusCheck(account.id, index));
});
