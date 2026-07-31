import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizePlanTier } from './plan-tier.js';

export function createPaymentLedger(root) {
  const file = path.join(root, 'config', 'payment-ledger.json');

  return { complete, get, latest, entries };

  function complete(input = {}) {
    const entry = normalizedEntry(input);
    const state = readState();
    const key = ledgerKey(entry.accountKey, entry.plan);
    if (state.completions[key]) return { ...state.completions[key] };
    state.completions[key] = entry;
    writeState(state);
    return { ...entry };
  }

  function get(accountKey, plan) {
    const normalizedPlan = normalizePlanTier(plan);
    if (!accountKey || !normalizedPlan) return null;
    const entry = readState().completions[ledgerKey(String(accountKey), normalizedPlan)];
    return entry ? { ...entry } : null;
  }

  function latest(accountKey) {
    const key = String(accountKey || '');
    if (!key) return null;
    const found = entries()
      .filter(entry => entry.accountKey === key)
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
    return found || null;
  }

  function entries() {
    return Object.values(readState().completions)
      .map(entry => ({ ...entry }))
      .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  }

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed?.version === 1 && parsed.completions && typeof parsed.completions === 'object'
        ? parsed
        : { version: 1, completions: {} };
    } catch {
      return { version: 1, completions: {} };
    }
  }

  function writeState(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }
}

function normalizedEntry(input) {
  const accountKey = String(input.accountKey || '').trim();
  const plan = normalizePlanTier(input.plan);
  const taskId = String(input.taskId || '').trim();
  const currency = String(input.currency || '').trim().toUpperCase();
  const amount = input.amount;
  if (!accountKey) throw new Error('payment ledger account key is required');
  if (!plan) throw new Error('payment ledger plan is required');
  if (!taskId) throw new Error('payment ledger task id is required');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('payment ledger amount must be positive');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('payment ledger currency is invalid');
  const completedAt = validIso(input.completedAt) || new Date().toISOString();
  const accountPlanBefore = normalizePlanTier(input.accountPlanBefore);
  return {
    accountKey,
    plan,
    taskId,
    amount,
    currency,
    completedAt,
    ...(input.via3ds === true ? { via3ds: true } : {}),
    ...(accountPlanBefore ? { accountPlanBefore } : {})
  };
}

function ledgerKey(accountKey, plan) {
  return crypto.createHash('sha256').update(`${accountKey}\0${plan}`).digest('hex');
}

function validIso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '';
  return new Date(value).toISOString();
}
