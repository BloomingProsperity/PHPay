import { normalizePlanTier } from './plan-tier.js';

const MAX_TIMER_DELAY = 2_147_483_647;

export function createThreeDsObserver({
  paymentTasks,
  resources,
  checkAccountStatus,
  claimCompletion,
  finishSuccessfulTask,
  finishFailedTask = async () => {},
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  firstDelayMs = 120_000,
  intervalMs = 25_000,
  acquireAccountCheck,
  releaseAccountCheck,
  onError = () => {}
}) {
  if (!paymentTasks || !resources) throw new TypeError('task and resource stores are required');
  if (typeof checkAccountStatus !== 'function') throw new TypeError('checkAccountStatus is required');
  if (typeof claimCompletion !== 'function') throw new TypeError('claimCompletion is required');
  if (typeof finishSuccessfulTask !== 'function') throw new TypeError('finishSuccessfulTask is required');
  if (typeof finishFailedTask !== 'function') throw new TypeError('finishFailedTask must be a function');
  if (typeof onError !== 'function') throw new TypeError('onError must be a function');
  if (
    (acquireAccountCheck !== undefined || releaseAccountCheck !== undefined) &&
    (typeof acquireAccountCheck !== 'function' || typeof releaseAccountCheck !== 'function')
  ) {
    throw new TypeError('account check guard requires acquire and release functions');
  }

  const timers = new Map();
  const checkingTasks = new Set();
  const localAccountChecks = new Set();
  const acquire = acquireAccountCheck || (id => {
    if (localAccountChecks.has(id)) return false;
    localAccountChecks.add(id);
    return true;
  });
  const release = releaseAccountCheck || (id => {
    localAccountChecks.delete(id);
  });
  let closed = false;

  return { register, recover, stop, close, isScheduled };

  function register(id) {
    const taskId = String(id || '');
    if (closed || timers.has(taskId) || checkingTasks.has(taskId)) return false;

    let task = paymentTasks.getInternal(taskId);
    if (!task || !isObservableState(task.state)) return false;

    let nextCheckAt = timestamp(task.nextAccountCheckAt);
    if (task.state === 'completing_3ds') {
      scheduleAt(taskId, nextCheckAt ?? now());
      return true;
    }

    const patch = {};
    if (nextCheckAt === null) {
      const detectedAt = timestamp(task.threeDsDetectedAt);
      nextCheckAt = (detectedAt ?? now()) + firstDelayMs;
      patch.nextAccountCheckAt = iso(nextCheckAt);
    }
    if (timestamp(task.firstAccountCheckAt) === null) {
      patch.firstAccountCheckAt = iso(nextCheckAt);
    }
    if (Object.keys(patch).length) {
      paymentTasks.update(taskId, patch);
      task = paymentTasks.getInternal(taskId);
      if (!task || !isObservableState(task.state)) return false;
      if (task.state === 'completing_3ds') {
        scheduleAt(taskId, timestamp(task.nextAccountCheckAt) ?? now());
        return true;
      }
    }

    scheduleAt(taskId, nextCheckAt);
    return true;
  }

  function recover() {
    if (closed) return 0;
    const tasks = [
      ...paymentTasks.list({ state: 'pending_3ds' }),
      ...paymentTasks.list({ state: 'completing_3ds' })
    ];
    let count = 0;
    for (const task of tasks) {
      if (register(task.id)) count++;
    }
    return count;
  }

  function stop(id) {
    const taskId = String(id || '');
    if (!timers.has(taskId)) return false;
    const handle = timers.get(taskId);
    timers.delete(taskId);
    clearTimer(handle);
    return true;
  }

  function close() {
    closed = true;
    for (const handle of timers.values()) clearTimer(handle);
    timers.clear();
  }

  function isScheduled(id) {
    return timers.has(String(id || ''));
  }

  function scheduleAt(taskId, dueAt) {
    if (closed || timers.has(taskId)) return;
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, dueAt - now()));
    let handle;
    const callback = () => {
      if (timers.get(taskId) !== handle) return;
      timers.delete(taskId);
      return Promise.resolve()
        .then(() => {
          if (closed) return;
          if (dueAt > now()) {
            register(taskId);
            return;
          }
          return runCheck(taskId);
        })
        .catch(error => {
          try {
            handleUnexpected(error, taskId);
          } catch (retryError) {
            report(retryError, taskId);
          }
        });
    };
    handle = setTimer(callback, delay);
    timers.set(taskId, handle);
  }

  async function runCheck(taskId) {
    if (closed || checkingTasks.has(taskId)) return;

    let task = paymentTasks.getInternal(taskId);
    if (!task || !isObservableState(task.state)) return;
    checkingTasks.add(taskId);

    try {
      if (task.state === 'completing_3ds') {
        await finishClaimedTask(taskId, task);
        return;
      }

      const accountId = String(task.accountResourceId || '');
      const account = resources.get('accounts', accountId);
      if (!account) {
        await failObservedTask(taskId, 'account_resource_not_found');
        return;
      }

      const ownsAccountCheck = acquire(accountId);
      if (!ownsAccountCheck) {
        retryLater(taskId);
        return;
      }

      let result;
      let didThrow = false;
      let callbackError;
      try {
        result = await checkAccountStatus({ task, account });
      } catch (error) {
        didThrow = true;
        callbackError = error;
      } finally {
        release(accountId);
      }

      task = paymentTasks.getInternal(taskId);
      if (closed || !task || task.state !== 'pending_3ds') return;

      const checkedAt = now();
      const errorCode = safeErrorCode(
        didThrow ? callbackError?.code : result?.errorCode,
        didThrow ? 'account_status_check_failed' : ''
      );
      if (errorCode === 'invalid_account_credential') {
        await failObservedTask(taskId, errorCode, checkedAt);
        return;
      }

      if (didThrow || errorCode) {
        retryLater(taskId, {
          lastAccountCheckAt: iso(checkedAt),
          accountCheckErrorCode: errorCode
        });
        return;
      }

      const observedPlan = normalizePlanTier(result?.plan);
      const targetPlan = normalizePlanTier(task.plan);
      const baselinePlan = normalizePlanTier(task.accountPlanBefore);
      if (observedPlan && observedPlan === targetPlan && observedPlan !== baselinePlan) {
        const claimPatch = {
          accountPlanCurrent: observedPlan,
          lastAccountCheckAt: iso(checkedAt),
          nextAccountCheckAt: '',
          accountCheckErrorCode: '',
          completionSource: 'account_tier_after_3ds',
          threeDsCompletedAt: iso(checkedAt)
        };
        const claimed = await claimCompletion(taskId, claimPatch);
        if (!claimed) {
          task = paymentTasks.getInternal(taskId);
          if (!closed && task && isObservableState(task.state)) retryLater(taskId);
          return;
        }
        if (claimed.state !== 'completing_3ds') {
          throw new Error('claimCompletion returned an invalid task state');
        }
        if (closed) return;
        await finishClaimedTask(taskId, claimed);
        return;
      }

      retryLater(taskId, {
        ...(observedPlan ? { accountPlanCurrent: observedPlan } : {}),
        lastAccountCheckAt: iso(checkedAt),
        accountCheckErrorCode: errorCode
      });
    } finally {
      checkingTasks.delete(taskId);
    }
  }

  async function finishClaimedTask(taskId, claimedTask) {
    let didThrow = false;
    try {
      await finishSuccessfulTask(claimedTask);
    } catch {
      didThrow = true;
    }

    const task = paymentTasks.getInternal(taskId);
    if (closed || !task || task.state !== 'completing_3ds') return;
    if (didThrow) {
      retryLater(taskId, { accountCheckErrorCode: 'account_completion_failed' });
      return;
    }

    const updated = paymentTasks.update(taskId, {
      state: 'succeeded',
      nextAccountCheckAt: '',
      accountCheckErrorCode: ''
    });
    if (!updated) throw new Error('completed task could not be persisted');
  }

  async function failObservedTask(taskId, errorCode, checkedAt = now()) {
    const failed = paymentTasks.update(taskId, {
      state: 'failed',
      errorCode,
      lastAccountCheckAt: iso(checkedAt),
      accountCheckErrorCode: errorCode,
      nextAccountCheckAt: ''
    });
    if (failed?.state === 'failed') {
      await finishFailedTask(paymentTasks.getInternal(taskId) || failed);
    }
  }

  function retryLater(taskId, patch = {}) {
    const nextCheckAt = now() + intervalMs;
    try {
      paymentTasks.update(taskId, { ...patch, nextAccountCheckAt: iso(nextCheckAt) });
    } finally {
      scheduleAt(taskId, nextCheckAt);
    }
  }

  function handleUnexpected(error, taskId) {
    report(error, taskId);
    if (closed) return;

    let task;
    try {
      task = paymentTasks.getInternal(taskId);
    } catch {
      task = { state: 'pending_3ds' };
    }
    if (!task || !isObservableState(task.state)) return;

    const nextCheckAt = now() + intervalMs;
    try {
      paymentTasks.update(taskId, {
        accountCheckErrorCode: 'observer_internal_error',
        nextAccountCheckAt: iso(nextCheckAt)
      });
    } catch {}
    try {
      scheduleAt(taskId, nextCheckAt);
    } catch (timerError) {
      report(timerError, taskId);
    }
  }

  function report(error, taskId) {
    try {
      onError(error, { taskId });
    } catch {}
  }
}

function timestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function isObservableState(state) {
  return state === 'pending_3ds' || state === 'completing_3ds';
}

function safeErrorCode(value, fallback = '') {
  const code = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return code || fallback;
}
