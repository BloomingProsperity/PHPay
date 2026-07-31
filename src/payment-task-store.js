import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizePlanTier } from './plan-tier.js';
import { paymentFailureAction } from './payment-error.js';

const PUBLIC_FIELDS = [
  'id', 'state', 'stage', 'email', 'cardLast4', 'amount', 'currency', 'plan',
  'verificationUrl', 'errorCode', 'accountPlanBefore', 'accountPlanCurrent',
  'threeDsDetectedAt', 'firstAccountCheckAt', 'lastAccountCheckAt',
  'nextAccountCheckAt', 'accountCheckErrorCode', 'completionSource',
  'threeDsCompletedAt', 'fingerprintId', 'fingerprintLabel',
  'fingerprintReused', 'retryAction', 'createdAt', 'updatedAt'
];
const UPDATABLE_FIELDS = new Set([
  'state', 'stage', 'email', 'cardLast4', 'amount', 'currency',
  'verificationUrl', 'errorCode', 'checkoutSessionId', 'processorEntity',
  'accountPlanBefore', 'accountPlanCurrent', 'threeDsDetectedAt',
  'firstAccountCheckAt', 'lastAccountCheckAt', 'nextAccountCheckAt',
  'accountCheckErrorCode', 'completionSource', 'threeDsCompletedAt',
  'fingerprintId', 'fingerprintLabel', 'fingerprintReused', 'fingerprintProfile'
]);
const THREE_DS_COMPLETION_FIELDS = new Set([
  'accountPlanCurrent', 'lastAccountCheckAt', 'nextAccountCheckAt',
  'accountCheckErrorCode', 'completionSource', 'threeDsCompletedAt'
]);

export function createPaymentTaskStore(root) {
  const directory = path.join(root, 'payment-tasks');
  return {
    create,
    get,
    getInternal,
    update,
    claimThreeDsCompletion,
    failUnresolved,
    list,
    clearSucceeded,
    clearTerminal
  };

  function create(input = {}) {
    const key = String(input.idempotencyKey || '').trim();
    if (!key) throw new Error('idempotency key is required');
    const found = readAll().find(task => task.idempotencyKey === key);
    if (found) return { ...toPublic(found), reused: true };
    const now = new Date().toISOString();
    const task = {
      id: crypto.randomUUID(),
      idempotencyKey: key,
      state: validState(input.state) ? input.state : 'processing',
      stage: validStage(input.stage) ? input.stage : 'preconfirm',
      email: String(input.email || ''),
      cardLast4: last4(input.cardLast4),
      amount: wholeMoney(input.amount),
      currency: currency(input.currency),
      plan: plan(input.plan),
      verificationUrl: safeUrl(input.verificationUrl),
      errorCode: safeCode(input.errorCode),
      accountPlanBefore: normalizePlanTier(input.accountPlanBefore),
      accountPlanCurrent: normalizePlanTier(input.accountPlanCurrent),
      threeDsDetectedAt: isoTimestamp(input.threeDsDetectedAt),
      firstAccountCheckAt: isoTimestamp(input.firstAccountCheckAt),
      lastAccountCheckAt: isoTimestamp(input.lastAccountCheckAt),
      nextAccountCheckAt: isoTimestamp(input.nextAccountCheckAt),
      accountCheckErrorCode: safeCode(input.accountCheckErrorCode),
      completionSource: completionSource(input.completionSource),
      threeDsCompletedAt: isoTimestamp(input.threeDsCompletedAt),
      fingerprintId: fingerprintId(input.fingerprintId),
      fingerprintLabel: fingerprintLabel(input.fingerprintLabel),
      fingerprintReused: input.fingerprintReused === true,
      fingerprintProfile: fingerprintProfile(input.fingerprintProfile),
      checkoutSessionId: String(input.checkoutSessionId || ''),
      networkSlot: networkSlot(input.networkSlot),
      networkProxy: networkProxy(input.networkProxy),
      accountResourceId: accountResourceId(input.accountResourceId),
      cardResourceId: resourceId('cards', input.cardResourceId),
      addressResourceId: resourceId('addresses', input.addressResourceId),
      createdAt: now,
      updatedAt: now
    };
    write(task);
    return toPublic(task);
  }

  function get(id) {
    const task = read(id);
    return task ? toPublic(task) : null;
  }

  function getInternal(id) {
    return read(id);
  }

  function update(id, patch = {}) {
    const current = read(id);
    if (!current) return null;
    applyTaskPatch(current, patch, UPDATABLE_FIELDS);
    current.updatedAt = new Date().toISOString();
    write(current);
    return toPublic(current);
  }

  function claimThreeDsCompletion(id, patch = {}) {
    const current = read(id);
    if (!current || current.state !== 'pending_3ds') return null;
    applyTaskPatch(current, patch, THREE_DS_COMPLETION_FIELDS);
    current.state = 'completing_3ds';
    current.updatedAt = new Date().toISOString();
    write(current);
    return { ...current };
  }

  function failUnresolved(id, errorCode = 'user_cancelled') {
    const current = read(id);
    if (!current || !['pending_3ds', 'unknown'].includes(current.state)) return null;
    current.state = 'failed';
    current.errorCode = safeCode(errorCode) || 'user_cancelled';
    current.nextAccountCheckAt = '';
    current.updatedAt = new Date().toISOString();
    write(current);
    return { ...current };
  }

  function list(options = {}) {
    const state = validState(options.state) ? options.state : '';
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 1000) : Infinity;
    return readAll()
      .filter(task => !state || task.state === state)
      .map(toPublic)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  function clearSucceeded() {
    return clearTerminal(['succeeded']);
  }

  function clearTerminal(states = ['succeeded', 'failed']) {
    const allowed = new Set(
      (Array.isArray(states) ? states : [states]).filter(state => state === 'succeeded' || state === 'failed')
    );
    let cleared = 0;
    for (const task of readAll()) {
      if (!allowed.has(task.state)) continue;
      fs.unlinkSync(path.join(directory, `${task.id}.json`));
      cleared++;
    }
    return cleared;
  }

  function read(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
    const file = path.join(directory, `${id}.json`);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  function readAll() {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter(file => /^[0-9a-f-]{36}\.json$/i.test(file))
      .flatMap(file => {
        try { return [JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))]; } catch { return []; }
      });
  }

  function write(task) {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${task.id}.json`);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(task, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}

function toPublic(task) {
  return Object.fromEntries(PUBLIC_FIELDS.map(field => [
    field,
    field === 'retryAction'
      ? paymentFailureAction(task)
      : task[field] ?? (field === 'amount' ? null : field === 'fingerprintReused' ? false : '')
  ]));
}

function applyTaskPatch(task, patch, allowedFields) {
  for (const [key, value] of Object.entries(patch)) {
    if (!allowedFields.has(key)) continue;
    if (key === 'state' && validStateTransition(task.state, value)) task.state = value;
    if (key === 'stage' && validStage(value)) task.stage = value;
    if (key === 'email') task.email = String(value || '');
    if (key === 'cardLast4') task.cardLast4 = last4(value);
    if (key === 'amount') task.amount = wholeMoney(value);
    if (key === 'currency') task.currency = currency(value);
    if (key === 'verificationUrl') task.verificationUrl = safeUrl(value);
    if (key === 'errorCode') task.errorCode = safeCode(value);
    if (key === 'checkoutSessionId') task.checkoutSessionId = String(value || '');
    if (key === 'processorEntity') task.processorEntity = String(value || '');
    if (key === 'accountPlanBefore') task.accountPlanBefore = normalizePlanTier(value);
    if (key === 'accountPlanCurrent') task.accountPlanCurrent = normalizePlanTier(value);
    if (key === 'threeDsDetectedAt') task.threeDsDetectedAt = isoTimestamp(value);
    if (key === 'firstAccountCheckAt') task.firstAccountCheckAt = isoTimestamp(value);
    if (key === 'lastAccountCheckAt') task.lastAccountCheckAt = isoTimestamp(value);
    if (key === 'nextAccountCheckAt') task.nextAccountCheckAt = isoTimestamp(value);
    if (key === 'accountCheckErrorCode') task.accountCheckErrorCode = safeCode(value);
    if (key === 'completionSource') task.completionSource = completionSource(value);
    if (key === 'threeDsCompletedAt') task.threeDsCompletedAt = isoTimestamp(value);
    if (key === 'fingerprintId') task.fingerprintId = fingerprintId(value);
    if (key === 'fingerprintLabel') task.fingerprintLabel = fingerprintLabel(value);
    if (key === 'fingerprintReused') task.fingerprintReused = value === true;
    if (key === 'fingerprintProfile') task.fingerprintProfile = fingerprintProfile(value);
  }
}

function validState(value) {
  return ['processing', 'pending_3ds', 'completing_3ds', 'succeeded', 'failed', 'unknown'].includes(value);
}

function validStateTransition(current, next) {
  if (!validState(next)) return false;
  if (current === 'completing_3ds') return next === 'completing_3ds' || next === 'succeeded';
  if (current === 'succeeded') return next === 'succeeded';
  return true;
}

function validStage(value) {
  return ['preconfirm', 'confirm_started', 'approve_started', 'polling'].includes(value);
}

function last4(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.slice(-4);
}

function wholeMoney(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function currency(value) {
  return /^[A-Z]{3}$/.test(String(value || '')) ? String(value) : '';
}

function plan(value) {
  const id = String(value || '');
  return /^[a-z0-9_-]{1,80}$/i.test(id) ? id : '';
}

function safeCode(value) {
  return /^[a-z0-9_-]{1,80}$/i.test(String(value || '')) ? String(value) : '';
}

function isoTimestamp(value) {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return '';
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return '';
  if (hour > 23 || minute > 59 || second > 59) return '';
  if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return '';
  return value;
}

function completionSource(value) {
  return value === 'account_tier_after_3ds' ? value : '';
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function accountResourceId(value) {
  const id = String(value || '');
  return /^accounts_[a-f0-9]{24}$/.test(id) ? id : '';
}

function resourceId(kind, value) {
  const id = String(value || '');
  return new RegExp(`^${kind}_[a-f0-9]{24}$`).test(id) ? id : '';
}

function networkSlot(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function networkProxy(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function fingerprintId(value) {
  const id = String(value || '');
  return /^[a-z0-9_-]{1,120}$/i.test(id) ? id : '';
}

function fingerprintLabel(value) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120);
}

function fingerprintProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const encoded = JSON.stringify(value);
    return encoded.length <= 32_768 ? JSON.parse(encoded) : {};
  } catch {
    return {};
  }
}
