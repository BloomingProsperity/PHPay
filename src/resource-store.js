import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizePlanTier } from './plan-tier.js';
import { mergeAccountCredential, stableAccountKey } from './account-identity.js';
import { createPaymentLedger } from './payment-ledger.js';

const dirFor = { accounts: 'accounts', cards: 'cards', addresses: 'addresses' };
const cardEventField = {
  submitted: 'submittedAt',
  three_ds: 'threeDsAt',
  succeeded: 'succeededAt'
};

export function createResourceStore(root) {
  const paymentLedger = createPaymentLedger(root);
  migrateLegacyAccountCompletions();
  return {
    add, list, get, remove, clear, completeAccount, updateAccountStatus, reserve,
    recordCardEvent, recordPaidUsage, markCardInsufficient, restoreCard, release,
    releaseOrphanedLocks
  };

  function add(kind, data, source = {}) {
    assertKind(kind);
    if (kind === 'accounts') {
      const accountKey = stableAccountKey(data);
      const existing = accountKey
        ? readAll('accounts').find(item => stableAccountKey(item.data) === accountKey)
        : null;
      if (existing) {
        const merged = mergeAccountCredential(existing.data, data);
        writeAtomically(path.join(resourceDir('accounts'), existing.file), merged);
        return { status: 'duplicate', id: existing.id, updated: true };
      }
    }
    const id = resourceId(kind, data);
    const existing = readAll(kind).find(item => item.id === id);
    if (existing) return { status: 'duplicate', id };
    const meta = {
      id,
      importedAt: new Date().toISOString(),
      source: { file: source.file || '', line: source.line ?? null }
    };
    if (kind === 'accounts') {
      const completed = paymentLedger.latest(stableAccountKey(data));
      if (completed) {
        meta.accountStatus = {
          state: 'active',
          plan: completed.plan,
          checkedAt: completed.completedAt,
          errorCode: ''
        };
        meta.payment = paymentFromLedger(completed);
      }
    }
    const record = { ...data, _resource: meta };
    const file = nextFile(kind, data);
    fs.mkdirSync(resourceDir(kind), { recursive: true });
    writeAtomically(path.join(resourceDir(kind), file), record);
    return { status: 'added', id };
  }

  function list(kind) {
    assertKind(kind);
    return readAll(kind).map(item => viewFor(kind, item)).sort((a, b) => a.importedAt.localeCompare(b.importedAt));
  }

  function get(kind, id) {
    assertKind(kind);
    const item = readAll(kind).find(value => value.id === id);
    return item ? item.data : null;
  }

  function remove(kind, id) {
    assertKind(kind);
    const entry = readAll(kind).find(item => item.id === id);
    if (!entry) return false;
    fs.unlinkSync(path.join(resourceDir(kind), entry.file));
    return true;
  }

  function clear(kind) {
    assertKind(kind);
    let count = 0;
    for (const entry of readAll(kind)) {
      fs.unlinkSync(path.join(resourceDir(kind), entry.file));
      count++;
    }
    return count;
  }

  function completeAccount(id, outcome = {}) {
    const entry = readAll('accounts').find(item => item.id === id);
    if (!entry) return null;
    if (!Number.isSafeInteger(outcome.amount) || outcome.amount <= 0 || !/^[A-Z]{3}$/.test(String(outcome.currency || ''))) {
      throw new Error('completed account requires a positive actual amount and currency');
    }
    const currentMeta = entry.data._resource || {};
    const currentPayment = isRecord(currentMeta.payment) && currentMeta.payment.state === 'completed' ? currentMeta.payment : {};
    const plan = String(outcome.plan || currentPayment.plan || '');
    const via3ds = currentPayment.via3ds === true || outcome.via3ds === true
      ? true
      : (typeof currentPayment.via3ds === 'boolean'
          ? currentPayment.via3ds
          : (typeof outcome.via3ds === 'boolean' ? outcome.via3ds : undefined));
    const accountPlanBefore = normalizePlanTier(currentPayment.accountPlanBefore) || normalizePlanTier(outcome.accountPlanBefore);
    const accountKey = stableAccountKey(entry.data);
    const completed = accountKey && normalizePlanTier(plan)
      ? paymentLedger.complete({
          accountKey,
          taskId: String(outcome.taskId || currentPayment.taskId || ''),
          amount: outcome.amount,
          currency: String(outcome.currency),
          plan,
          via3ds,
          accountPlanBefore,
          completedAt: currentPayment.completedAt
        })
      : null;
    const finalPayment = completed ? paymentFromLedger(completed) : {
      state: 'completed',
      taskId: String(outcome.taskId || currentPayment.taskId || ''),
      amount: outcome.amount,
      currency: String(outcome.currency),
      completedAt: currentPayment.completedAt || new Date().toISOString(),
      ...(plan ? { plan } : {}),
      ...(typeof via3ds === 'boolean' ? { via3ds } : {}),
      ...(accountPlanBefore ? { accountPlanBefore } : {})
    };
    entry.data._resource = {
      ...currentMeta,
      accountStatus: { state: 'active', plan: finalPayment.plan || plan, checkedAt: new Date().toISOString(), errorCode: '' },
      payment: finalPayment
    };
    writeAtomically(path.join(resourceDir('accounts'), entry.file), entry.data);
    return viewFor('accounts', entry);
  }

  function updateAccountStatus(id, status = {}) {
    const entry = readAll('accounts').find(item => item.id === id);
    if (!entry) return null;
    const current = entry.data._resource || {};
    const nextState = String(status.state || 'unknown');
    if (current.payment?.state === 'completed') {
      return viewFor('accounts', entry);
    }
    const completedPlan = current.payment?.plan || current.accountStatus?.plan || '';
    entry.data._resource = {
      ...current,
      accountStatus: {
        state: nextState,
        plan: String(status.plan || (nextState === 'active' ? completedPlan : '')),
        checkedAt: new Date().toISOString(),
        errorCode: String(status.errorCode || '')
      }
    };
    writeAtomically(path.join(resourceDir('accounts'), entry.file), entry.data);
    return viewFor('accounts', entry);
  }

  function reserve(kind, id, taskId) {
    assertKind(kind);
    const entry = readAll(kind).find(item => item.id === id);
    if (!entry || !taskId) return false;
    const meta = entry.data._resource || {};
    if (kind === 'accounts' && meta.payment?.state === 'completed') return false;
    if (kind === 'cards' && meta.usage?.blockedReason === 'insufficient_funds') return false;
    if (kind === 'cards' && Date.parse(meta.usage?.cooldownUntil || '') > Date.now()) return false;
    if (meta.lock?.taskId && meta.lock.taskId !== taskId) return false;
    entry.data._resource = { ...meta, lock: { taskId: String(taskId), lockedAt: new Date().toISOString() } };
    writeAtomically(path.join(resourceDir(kind), entry.file), entry.data);
    return true;
  }

  function recordCardEvent(id, taskId, event) {
    if (
      typeof id !== 'string' || !id ||
      typeof taskId !== 'string' || !taskId.trim() ||
      typeof event !== 'string' || !Object.hasOwn(cardEventField, event)
    ) {
      return false;
    }
    const entry = readAll('cards').find(item => item.id === id);
    if (!entry) return false;
    const meta = entry.data._resource || {};
    if (meta.lock?.taskId !== taskId) return false;

    const usage = isRecord(meta.usage) ? meta.usage : {};
    const cardTasks = isRecord(usage.cardTasks) ? usage.cardTasks : {};
    const task = isRecord(cardTasks[taskId]) ? cardTasks[taskId] : {};
    const field = cardEventField[event];
    if (task[field]) return true;

    const recordedAt = new Date().toISOString();
    entry.data._resource = {
      ...meta,
      usage: {
        ...usage,
        ...(event === 'submitted' ? { lastUsedAt: recordedAt } : {}),
        cardTasks: {
          ...cardTasks,
          [taskId]: { ...task, [field]: recordedAt }
        }
      }
    };
    writeAtomically(path.join(resourceDir('cards'), entry.file), entry.data);
    return true;
  }

  function release(kind, id, taskId, outcome = {}) {
    assertKind(kind);
    const entry = readAll(kind).find(item => item.id === id);
    if (!entry || entry.data._resource?.lock?.taskId !== taskId) return false;
    const { lock, ...meta } = entry.data._resource || {};
    if (outcome.recordUsage === false) {
      entry.data._resource = meta;
      writeAtomically(path.join(resourceDir(kind), entry.file), entry.data);
      return true;
    }
    const recordedAt = new Date().toISOString();
    const currentUsage = isRecord(meta.usage) ? meta.usage : {};
    const paidUsage = outcome.paid ? withPaidTask(currentUsage, taskId, recordedAt) : currentUsage;
    const paidAccountCount = safePaidAccountCount(paidUsage.paidAccountCount);
    const cooldownMs = Number.isFinite(outcome.cooldownMs) && outcome.cooldownMs > 0 ? outcome.cooldownMs : 0;
    const usage = { ...paidUsage, lastUsedAt: recordedAt, paidAccountCount };
    if (cooldownMs) usage.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
    else delete usage.cooldownUntil;
    entry.data._resource = { ...meta, usage };
    writeAtomically(path.join(resourceDir(kind), entry.file), entry.data);
    return true;
  }

  function releaseOrphanedLocks(activeTaskIds = new Set()) {
    const active = activeTaskIds instanceof Set
      ? activeTaskIds
      : new Set(Array.isArray(activeTaskIds) ? activeTaskIds : []);
    let released = 0;
    for (const kind of ['accounts', 'cards', 'addresses']) {
      for (const entry of readAll(kind)) {
        const taskId = String(entry.data?._resource?.lock?.taskId || '');
        if (!taskId || active.has(taskId)) continue;
        const { lock: _lock, ...meta } = entry.data._resource || {};
        entry.data._resource = meta;
        writeAtomically(path.join(resourceDir(kind), entry.file), entry.data);
        released++;
      }
    }
    return released;
  }

  function recordPaidUsage(kind, id, taskId) {
    assertKind(kind);
    const entry = readAll(kind).find(item => item.id === id);
    if (!entry || entry.data._resource?.lock?.taskId !== taskId) return false;
    const meta = entry.data._resource || {};
    const usage = isRecord(meta.usage) ? meta.usage : {};
    const paidTasks = isRecord(usage.paidTasks) ? usage.paidTasks : {};
    if (Object.hasOwn(paidTasks, taskId)) return true;
    entry.data._resource = {
      ...meta,
      usage: withPaidTask(usage, taskId, new Date().toISOString())
    };
    writeAtomically(path.join(resourceDir(kind), entry.file), entry.data);
    return true;
  }

  function markCardInsufficient(id, taskId) {
    const entry = readAll('cards').find(item => item.id === id);
    if (!entry || entry.data._resource?.lock?.taskId !== taskId) return false;
    const { lock, ...meta } = entry.data._resource || {};
    entry.data._resource = {
      ...meta,
      usage: {
        ...(meta.usage || {}),
        lastUsedAt: new Date().toISOString(),
        blockedReason: 'insufficient_funds',
        lastFailureAt: new Date().toISOString()
      }
    };
    writeAtomically(path.join(resourceDir('cards'), entry.file), entry.data);
    return true;
  }

  function restoreCard(id) {
    const entry = readAll('cards').find(item => item.id === id);
    if (!entry) return false;
    const meta = entry.data._resource || {};
    const { blockedReason, lastFailureAt, ...usage } = meta.usage || {};
    entry.data._resource = { ...meta, usage };
    writeAtomically(path.join(resourceDir('cards'), entry.file), entry.data);
    return true;
  }

  function readAll(kind) {
    const dir = resourceDir(kind);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(file => file.endsWith('.json')).flatMap(file => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        const meta = data._resource || {};
        return [{
          id: meta.id || resourceId(kind, data),
          importedAt: meta.importedAt || fs.statSync(path.join(dir, file)).mtime.toISOString(),
          file,
          data
        }];
      } catch { return []; }
    });
  }

  function resourceDir(kind) { return path.join(root, dirFor[kind]); }

  function nextFile(kind, data) {
    const dir = resourceDir(kind);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.json')) : [];
    if (kind === 'accounts') {
      const email = String(data.user?.email || '').replace(/[^\w.@+-]/g, '_');
      const prefix = email || 'account';
      let number = 1;
      let candidate = `${prefix}.json`;
      while (files.includes(candidate)) candidate = `${prefix}-${number++}.json`;
      return candidate;
    }
    const prefix = kind === 'cards' ? `card-${String(data.number).slice(-4)}` : 'addr';
    let number = 1;
    while (files.includes(`${prefix}-${number}.json`)) number++;
    return `${prefix}-${number}.json`;
  }

  function migrateLegacyAccountCompletions() {
    for (const entry of readAll('accounts')) {
      const payment = entry.data?._resource?.payment;
      const accountKey = stableAccountKey(entry.data);
      if (
        !accountKey
        || payment?.state !== 'completed'
        || !normalizePlanTier(payment.plan)
        || !payment.taskId
        || !Number.isSafeInteger(payment.amount)
        || payment.amount <= 0
        || !/^[A-Z]{3}$/.test(String(payment.currency || ''))
      ) continue;
      paymentLedger.complete({
        accountKey,
        plan: payment.plan,
        taskId: payment.taskId,
        amount: payment.amount,
        currency: payment.currency,
        completedAt: payment.completedAt,
        via3ds: payment.via3ds,
        accountPlanBefore: payment.accountPlanBefore
      });
    }
  }
}

function assertKind(kind) {
  if (!Object.hasOwn(dirFor, kind)) throw new Error(`unknown resource kind: ${kind}`);
}

function resourceId(kind, data) {
  return `${kind}_${crypto.createHash('sha256').update(`${kind}\0${dedupeKey(kind, data)}`).digest('hex').slice(0, 24)}`;
}

function dedupeKey(kind, data) {
  if (kind === 'accounts') return stableAccountKey(data);
  if (kind === 'cards') return `${data.number}|${data.exp}|${data.cvc}`;
  return [data.line1, data.city, data.state, data.zip, data.country].map(value => String(value || '').trim().toLowerCase()).join('|');
}

function paymentFromLedger(entry) {
  return {
    state: 'completed',
    taskId: entry.taskId,
    amount: entry.amount,
    currency: entry.currency,
    completedAt: entry.completedAt,
    plan: entry.plan,
    ...(entry.via3ds === true ? { via3ds: true } : {}),
    ...(entry.accountPlanBefore ? { accountPlanBefore: entry.accountPlanBefore } : {})
  };
}

function viewFor(kind, item) {
  if (kind === 'accounts') {
    const payment = item.data._resource?.payment;
    const accountPlanBefore = normalizePlanTier(payment?.accountPlanBefore);
    const view = {
      id: item.id,
      label: item.data.user?.email || '待识别账号',
      importedAt: item.importedAt,
      accountStatus: item.data._resource?.accountStatus || { state: 'pending', plan: '', checkedAt: '', errorCode: '' },
      payment: payment?.state === 'completed' ? {
        state: 'completed',
        amount: payment.amount,
        currency: payment.currency,
        ...(payment.plan ? { plan: payment.plan } : {}),
        ...(typeof payment.via3ds === 'boolean' ? { via3ds: payment.via3ds } : {}),
        ...(accountPlanBefore ? { accountPlanBefore } : {})
      } : null
    };
    return withUsage(view, item.data);
  }
  if (kind === 'cards') return withUsage({ id: item.id, masked: `•••• ${String(item.data.number || '').slice(-4)}`, name: item.data.name || '', importedAt: item.importedAt }, item.data, true);
  return withUsage({ id: item.id, label: [item.data.city, item.data.state, item.data.country].filter(Boolean).join(', '), importedAt: item.importedAt }, item.data);
}

function withUsage(view, data, isCard = false) {
  const meta = data._resource || {};
  const counts = isCard ? cardUsageCounts(meta.usage) : { paidAccountCount: safePaidAccountCount(meta.usage?.paidAccountCount) };
  if (meta.lock?.taskId) return { ...view, usage: { state: 'in_use', ...counts } };
  if (meta.usage?.lastUsedAt) {
    if (meta.usage.blockedReason === 'insufficient_funds') {
      return { ...view, usage: { state: 'insufficient_funds', lastUsedAt: meta.usage.lastUsedAt, ...counts } };
    }
    const cooling = Date.parse(meta.usage.cooldownUntil || '') > Date.now();
    return {
      ...view,
      usage: {
        state: cooling ? 'cooldown' : 'available',
        lastUsedAt: meta.usage.lastUsedAt,
        ...counts,
        ...(cooling ? { cooldownUntil: meta.usage.cooldownUntil } : {})
      }
    };
  }
  if (isCard) return { ...view, usage: { state: 'available', ...counts } };
  return view;
}

function cardUsageCounts(usage = {}) {
  const paidAccountCount = safePaidAccountCount(usage?.paidAccountCount);
  const tasks = isRecord(usage?.cardTasks) ? Object.values(usage.cardTasks).filter(isRecord) : [];
  const submittedCount = tasks.filter(task => task.submittedAt).length;
  const succeededCount = tasks.filter(task => task.succeededAt).length;
  const threeDsCount = tasks.filter(task => task.threeDsAt).length;
  return {
    paidAccountCount,
    attemptCount: Math.max(submittedCount, paidAccountCount),
    successCount: Math.max(succeededCount, paidAccountCount),
    threeDsCount,
    hasThreeDs: threeDsCount > 0
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safePaidAccountCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function incrementPaidAccountCount(value) {
  const count = safePaidAccountCount(value);
  return count < Number.MAX_SAFE_INTEGER ? count + 1 : count;
}

function withPaidTask(usage, taskId, recordedAt) {
  const paidTasks = isRecord(usage.paidTasks) ? usage.paidTasks : {};
  if (Object.hasOwn(paidTasks, taskId)) {
    return { ...usage, paidAccountCount: safePaidAccountCount(usage.paidAccountCount) };
  }
  return {
    ...usage,
    lastUsedAt: recordedAt,
    paidAccountCount: incrementPaidAccountCount(usage.paidAccountCount),
    paidTasks: { ...paidTasks, [taskId]: recordedAt }
  };
}

function writeAtomically(file, data) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, file);
}
