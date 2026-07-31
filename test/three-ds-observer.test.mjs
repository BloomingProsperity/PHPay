import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createThreeDsObserver } from '../src/three-ds-observer.js';

const ACCOUNT_ID = 'accounts_aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_ACCOUNT_ID = 'accounts_bbbbbbbbbbbbbbbbbbbbbbbb';

test('register waits 120 seconds from 3DS detection, persists the schedule, and deduplicates timers', () => {
  const harness = createHarness({
    now: Date.parse('2026-07-30T00:00:00.000Z'),
    tasks: [pendingTask('task-1', {
      threeDsDetectedAt: '2026-07-30T00:00:00.000Z'
    })]
  });

  assert.equal(harness.observer.register('task-1'), true);
  assert.equal(harness.observer.register('task-1'), false);
  assert.deepEqual(harness.clock.delays(), [120_000]);
  assert.equal(harness.task('task-1').firstAccountCheckAt, '2026-07-30T00:02:00.000Z');
  assert.equal(harness.task('task-1').nextAccountCheckAt, '2026-07-30T00:02:00.000Z');
});

test('recover preserves persisted future times and runs overdue checks immediately', async () => {
  const now = Date.parse('2026-07-30T00:10:00.000Z');
  const harness = createHarness({
    now,
    tasks: [
      pendingTask('future', {
        nextAccountCheckAt: new Date(now + 30_000).toISOString()
      }),
      pendingTask('overdue', {
        accountResourceId: OTHER_ACCOUNT_ID,
        nextAccountCheckAt: new Date(now - 30_000).toISOString()
      })
    ],
    accounts: {
      [ACCOUNT_ID]: { accessToken: 'a' },
      [OTHER_ACCOUNT_ID]: { accessToken: 'b' }
    }
  });

  assert.equal(harness.observer.recover(), 2);
  assert.deepEqual(harness.listCalls, [
    { state: 'pending_3ds' },
    { state: 'completing_3ds' }
  ]);
  assert.deepEqual(harness.clock.delays(), [0, 30_000]);
  await harness.clock.advance(0);
  assert.equal(harness.checkCalls.length, 1);
  assert.equal(harness.checkCalls[0].task.id, 'overdue');
});

test('completion failure stays completing and retries the idempotent finalizer before persisting success', async () => {
  const finished = [];
  const harness = createHarness({
    tasks: [pendingTask('task-1', { plan: 'CHATGPTPLUS' })],
    checkAccountStatus: async () => ({ state: 'active', plan: 'CHATGPTPLUS', errorCode: '' }),
    finishSuccessfulTask: async task => {
      finished.push(task);
      if (finished.length === 1) throw new Error('temporary finalizer failure');
    }
  });

  harness.observer.register('task-1');
  await harness.clock.advance(120_000);
  assert.equal(harness.task('task-1').state, 'completing_3ds');
  assert.equal(harness.task('task-1').accountCheckErrorCode, 'account_completion_failed');
  assert.deepEqual(harness.clock.delays(), [25_000]);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].state, 'completing_3ds');
  assert.equal(finished[0].accountResourceId, ACCOUNT_ID);
  assert.equal(harness.checkCalls.length, 1);
  assert.equal(harness.claimCalls.length, 1);

  await harness.clock.advance(25_000);
  const task = harness.task('task-1');
  assert.equal(task.state, 'succeeded');
  assert.equal(task.accountPlanCurrent, 'chatgptplusplan');
  assert.equal(task.lastAccountCheckAt, '2026-07-30T00:02:00.000Z');
  assert.equal(task.nextAccountCheckAt, '');
  assert.equal(task.accountCheckErrorCode, '');
  assert.equal(task.completionSource, 'account_tier_after_3ds');
  assert.equal(task.threeDsCompletedAt, '2026-07-30T00:02:00.000Z');
  assert.equal(finished.length, 2);
  assert.equal(harness.checkCalls.length, 1);
  assert.equal(harness.claimCalls.length, 1);
  assert.equal(harness.observer.register('task-1'), false);
  await harness.clock.advance(250_000);
  assert.equal(finished.length, 2);
});

test('the baseline tier and other canonical active tiers remain pending and retry after 25 seconds', async () => {
  const statuses = [
    { state: 'active', plan: 'chatgptfreeplan', errorCode: '' },
    { state: 'active', plan: 'chatgptpro', errorCode: '' }
  ];
  const harness = createHarness({
    tasks: [pendingTask('task-1')],
    checkAccountStatus: async () => statuses.shift()
  });

  harness.observer.register('task-1');
  await harness.clock.advance(120_000);
  assert.equal(harness.task('task-1').state, 'pending_3ds');
  assert.equal(harness.task('task-1').accountPlanCurrent, 'chatgptfreeplan');
  assert.deepEqual(harness.clock.delays(), [25_000]);

  await harness.clock.advance(25_000);
  assert.equal(harness.task('task-1').state, 'pending_3ds');
  assert.equal(harness.task('task-1').accountPlanCurrent, 'chatgptpro');
  assert.deepEqual(harness.clock.delays(), [25_000]);

  const unknownTarget = createHarness({
    tasks: [pendingTask('unknown', {
      plan: 'enterprise_unknown',
      accountPlanBefore: ''
    })],
    checkAccountStatus: async () => ({ state: 'active', plan: 'chatgptplusplan', errorCode: '' })
  });
  unknownTarget.observer.register('unknown');
  await unknownTarget.clock.advance(120_000);
  assert.equal(unknownTarget.task('unknown').state, 'pending_3ds');
  assert.deepEqual(unknownTarget.clock.delays(), [25_000]);
});

test('temporary callback errors preserve the old current tier and retry safely', async () => {
  const harness = createHarness({
    tasks: [pendingTask('task-1', { accountPlanCurrent: 'chatgptpro' })],
    checkAccountStatus: async () => Promise.reject(undefined)
  });

  harness.observer.register('task-1');
  await harness.clock.advance(120_000);
  const task = harness.task('task-1');
  assert.equal(task.state, 'pending_3ds');
  assert.equal(task.accountPlanCurrent, 'chatgptpro');
  assert.equal(task.accountCheckErrorCode, 'account_status_check_failed');
  assert.equal(task.lastAccountCheckAt, '2026-07-30T00:02:00.000Z');
  assert.deepEqual(harness.clock.delays(), [25_000]);
});

test('invalid credentials and missing account resources fail the task and release held resources', async () => {
  const failed = [];
  const invalid = createHarness({
    tasks: [pendingTask('invalid')],
    finishFailedTask: async task => { failed.push({ id: task.id, code: task.accountCheckErrorCode }); },
    checkAccountStatus: async () => ({
      state: 'invalid',
      plan: '',
      errorCode: 'invalid_account_credential'
    })
  });
  invalid.observer.register('invalid');
  await invalid.clock.advance(120_000);
  assert.equal(invalid.task('invalid').state, 'failed');
  assert.equal(invalid.task('invalid').accountCheckErrorCode, 'invalid_account_credential');
  assert.equal(invalid.task('invalid').errorCode, 'invalid_account_credential');
  assert.equal(invalid.task('invalid').nextAccountCheckAt, '');
  assert.equal(invalid.observer.isScheduled('invalid'), false);

  const missing = createHarness({
    tasks: [pendingTask('missing')],
    accounts: {},
    finishFailedTask: async task => { failed.push({ id: task.id, code: task.accountCheckErrorCode }); }
  });
  missing.observer.register('missing');
  await missing.clock.advance(120_000);
  assert.equal(missing.task('missing').state, 'failed');
  assert.equal(missing.task('missing').accountCheckErrorCode, 'account_resource_not_found');
  assert.equal(missing.task('missing').errorCode, 'account_resource_not_found');
  assert.equal(missing.task('missing').nextAccountCheckAt, '');
  assert.equal(missing.checkCalls.length, 0);
  assert.deepEqual(failed, [
    { id: 'invalid', code: 'invalid_account_credential' },
    { id: 'missing', code: 'account_resource_not_found' }
  ]);
});

test('checks for the same account never overlap and a collision is deferred 25 seconds', async () => {
  let releaseFirst;
  let active = 0;
  let maximumActive = 0;
  const harness = createHarness({
    tasks: [pendingTask('first'), pendingTask('second')],
    checkAccountStatus: async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      if (!releaseFirst) {
        await new Promise(resolve => { releaseFirst = resolve; });
      }
      active--;
      return { state: 'free', plan: 'chatgptfreeplan', errorCode: '' };
    }
  });

  harness.observer.register('first');
  harness.observer.register('second');
  const firing = harness.clock.fireDueConcurrently(120_000);
  await Promise.resolve();
  assert.equal(harness.checkCalls.length, 1);
  releaseFirst();
  await firing;
  assert.equal(maximumActive, 1);
  assert.equal(harness.checkCalls.length, 1);
  assert.deepEqual(harness.clock.delays(), [25_000, 25_000]);
});

test('a cleared stale timer callback cannot run after the task is re-registered', async () => {
  const harness = createHarness({ tasks: [pendingTask('stale')] });
  harness.observer.register('stale');
  assert.equal(harness.observer.stop('stale'), true);
  harness.observer.register('stale');

  await harness.clock.deliverLastCleared();
  assert.equal(harness.checkCalls.length, 0);
  assert.equal(harness.observer.isScheduled('stale'), true);

  await harness.clock.advance(120_000);
  assert.equal(harness.checkCalls.length, 1);
});

test('an externally held account guard defers without releasing another owner lock', async () => {
  const held = new Set([ACCOUNT_ID]);
  const releases = [];
  const harness = createHarness({
    tasks: [pendingTask('guarded')],
    acquireAccountCheck(id) {
      if (held.has(id)) return false;
      held.add(id);
      return true;
    },
    releaseAccountCheck(id) {
      releases.push(id);
      held.delete(id);
    }
  });

  harness.observer.register('guarded');
  await harness.clock.advance(120_000);
  assert.equal(harness.checkCalls.length, 0);
  assert.equal(held.has(ACCOUNT_ID), true);
  assert.deepEqual(releases, []);
  assert.deepEqual(harness.clock.delays(), [25_000]);

  held.delete(ACCOUNT_ID);
  await harness.clock.advance(25_000);
  assert.equal(harness.checkCalls.length, 1);
  assert.deepEqual(releases, [ACCOUNT_ID]);
  assert.equal(held.has(ACCOUNT_ID), false);
});

test('unexpected callback errors are reported and retain an in-memory retry when persistence fails', async () => {
  const errors = [];
  const nextAt = '2026-07-30T00:02:00.000Z';
  const harness = createHarness({
    tasks: [pendingTask('unexpected', {
      firstAccountCheckAt: nextAt,
      nextAccountCheckAt: nextAt
    })],
    resourceGet() {
      throw new Error('resource store unavailable');
    },
    updateHook(_id, patch) {
      if (patch.accountCheckErrorCode === 'observer_internal_error') {
        throw new Error('task persistence unavailable');
      }
    },
    onError(error, context) {
      errors.push({ message: error?.message, context });
    }
  });

  harness.observer.register('unexpected');
  await harness.clock.advance(120_000);
  assert.deepEqual(errors, [{
    message: 'resource store unavailable',
    context: { taskId: 'unexpected' }
  }]);
  assert.equal(harness.task('unexpected').state, 'pending_3ds');
  assert.deepEqual(harness.clock.delays(), [25_000]);
});

test('delays beyond the platform timer maximum are chunked without checking early', async () => {
  const maximumTimerDelay = 2_147_483_647;
  const now = Date.parse('2026-07-30T00:00:00.000Z');
  const dueAt = now + maximumTimerDelay + 5_000;
  const harness = createHarness({
    now,
    tasks: [pendingTask('far-future', {
      firstAccountCheckAt: new Date(dueAt).toISOString(),
      nextAccountCheckAt: new Date(dueAt).toISOString()
    })]
  });

  harness.observer.register('far-future');
  assert.deepEqual(harness.clock.delays(), [maximumTimerDelay]);
  await harness.clock.advance(maximumTimerDelay);
  assert.equal(harness.checkCalls.length, 0);
  assert.deepEqual(harness.clock.delays(), [5_000]);
  await harness.clock.advance(5_000);
  assert.equal(harness.checkCalls.length, 1);
});

test('a state change while account status is awaited prevents every post-check side effect', async () => {
  let resolveStatus;
  let finishes = 0;
  const harness = createHarness({
    tasks: [pendingTask('in-flight')],
    checkAccountStatus: async () => new Promise(resolve => { resolveStatus = resolve; }),
    finishSuccessfulTask: async () => { finishes++; }
  });

  harness.observer.register('in-flight');
  const firing = harness.clock.fireDueConcurrently(120_000);
  await Promise.resolve();
  harness.paymentTasks.update('in-flight', { state: 'failed' });
  resolveStatus({ state: 'active', plan: 'chatgptplusplan', errorCode: '' });
  await firing;

  assert.equal(harness.task('in-flight').state, 'failed');
  assert.equal(harness.task('in-flight').lastAccountCheckAt, '');
  assert.equal(harness.observer.isScheduled('in-flight'), false);
  assert.equal(finishes, 0);
});

test('a completing task recovers immediately and replays only the idempotent finalizer', async () => {
  const finished = [];
  const harness = createHarness({
    tasks: [pendingTask('recover-completion', {
      state: 'completing_3ds',
      accountPlanCurrent: 'chatgptplusplan',
      lastAccountCheckAt: '2026-07-30T00:01:00.000Z',
      nextAccountCheckAt: '',
      completionSource: 'account_tier_after_3ds',
      threeDsCompletedAt: '2026-07-30T00:01:00.000Z'
    })],
    finishSuccessfulTask: async task => { finished.push(task); }
  });

  assert.equal(harness.observer.recover(), 1);
  assert.deepEqual(harness.clock.delays(), [0]);
  await harness.clock.advance(0);
  assert.equal(harness.task('recover-completion').state, 'succeeded');
  assert.equal(harness.checkCalls.length, 0);
  assert.equal(harness.claimCalls.length, 0);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].state, 'completing_3ds');
});

test('an atomic completion claim prevents a pending-only failure CAS during finalization', async () => {
  let finishStarted;
  let releaseFinish;
  let sideEffects = 0;
  const started = new Promise(resolve => { finishStarted = resolve; });
  const harness = createHarness({
    tasks: [pendingTask('claimed')],
    checkAccountStatus: async () => ({
      state: 'active',
      plan: 'chatgptplusplan',
      errorCode: ''
    }),
    finishSuccessfulTask: async () => {
      sideEffects++;
      finishStarted();
      await new Promise(resolve => { releaseFinish = resolve; });
    }
  });

  harness.observer.register('claimed');
  const firing = harness.clock.fireDueConcurrently(120_000);
  await started;
  const failedByOtherPath = harness.failPending('claimed');
  assert.equal(failedByOtherPath, false);
  assert.equal(harness.task('claimed').state, 'completing_3ds');
  releaseFinish();
  await firing;

  assert.equal(sideEffects, 1);
  assert.equal(harness.claimCalls.length, 1);
  assert.equal(harness.task('claimed').state, 'succeeded');
});

test('a task state change cancels its check, while stop and close clear pending timers', async () => {
  const harness = createHarness({
    tasks: [
      pendingTask('changed'),
      pendingTask('stopped', { accountResourceId: OTHER_ACCOUNT_ID })
    ],
    accounts: {
      [ACCOUNT_ID]: { accessToken: 'a' },
      [OTHER_ACCOUNT_ID]: { accessToken: 'b' }
    }
  });

  harness.observer.register('changed');
  harness.observer.register('stopped');
  harness.paymentTasks.update('changed', { state: 'failed' });
  assert.equal(harness.observer.stop('stopped'), true);
  await harness.clock.advance(120_000);
  assert.equal(harness.checkCalls.length, 0);
  assert.equal(harness.observer.isScheduled('changed'), false);

  harness.paymentTasks.update('changed', { state: 'pending_3ds' });
  harness.observer.register('changed');
  harness.observer.close();
  assert.equal(harness.clock.size, 0);
  assert.equal(harness.observer.register('changed'), false);
});

test('observer source is backend-only and has no payment confirmation dependencies', () => {
  const source = fs.readFileSync(new URL('../src/three-ds-observer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /stripe|payment\s*confirm|approve|recheck/i);
  assert.doesNotMatch(source, /currentPlan/);
  assert.match(source, /checkAccountStatus/);
});

test('construction rejects an observer without an atomic completion claim', () => {
  assert.throws(() => createThreeDsObserver({
    paymentTasks: {},
    resources: {},
    checkAccountStatus: async () => ({}),
    finishSuccessfulTask: async () => {}
  }), /claimCompletion/);
});

function pendingTask(id, overrides = {}) {
  return {
    id,
    state: 'pending_3ds',
    plan: 'chatgptplusplan',
    accountPlanBefore: 'chatgptfreeplan',
    accountPlanCurrent: '',
    accountResourceId: ACCOUNT_ID,
    networkSlot: 0,
    threeDsDetectedAt: '',
    firstAccountCheckAt: '',
    lastAccountCheckAt: '',
    nextAccountCheckAt: '',
    accountCheckErrorCode: '',
    completionSource: '',
    threeDsCompletedAt: '',
    ...overrides
  };
}

function createHarness({
  now = Date.parse('2026-07-30T00:00:00.000Z'),
  tasks = [],
  accounts = { [ACCOUNT_ID]: { accessToken: 'secret' } },
  checkAccountStatus = async () => ({ state: 'active', plan: 'chatgptfreeplan', errorCode: '' }),
  finishSuccessfulTask = async () => {},
  finishFailedTask = async () => {},
  acquireAccountCheck,
  releaseAccountCheck,
  resourceGet,
  updateHook,
  onError,
  claimCompletion: injectedClaimCompletion
} = {}) {
  const taskMap = new Map(tasks.map(task => [task.id, structuredClone(task)]));
  const clock = createFakeClock(now);
  const checkCalls = [];
  const claimCalls = [];
  const listCalls = [];
  const paymentTasks = {
    get(id) {
      const task = taskMap.get(id);
      return task ? structuredClone(task) : null;
    },
    getInternal(id) {
      const task = taskMap.get(id);
      return task ? structuredClone(task) : null;
    },
    update(id, patch) {
      const task = taskMap.get(id);
      if (!task) return null;
      updateHook?.(id, patch);
      Object.assign(task, structuredClone(patch));
      return structuredClone(task);
    },
    list(options = {}) {
      listCalls.push(structuredClone(options));
      const { state } = options;
      return [...taskMap.values()]
        .filter(task => !state || task.state === state)
        .map(task => structuredClone(task));
    }
  };
  const resources = {
    get(kind, id) {
      assert.equal(kind, 'accounts');
      if (resourceGet) return resourceGet(kind, id);
      return accounts[id] ? structuredClone(accounts[id]) : null;
    }
  };
  const claimCompletion = injectedClaimCompletion || (async (id, patch) => {
    claimCalls.push({ id, patch: structuredClone(patch) });
    const task = taskMap.get(id);
    if (!task || task.state !== 'pending_3ds') return null;
    Object.assign(task, structuredClone(patch), { state: 'completing_3ds' });
    return structuredClone(task);
  });
  const observer = createThreeDsObserver({
    paymentTasks,
    resources,
    checkAccountStatus: async input => {
      checkCalls.push(input);
      return checkAccountStatus(input);
    },
    claimCompletion,
    finishSuccessfulTask,
    finishFailedTask,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...(acquireAccountCheck ? { acquireAccountCheck } : {}),
    ...(releaseAccountCheck ? { releaseAccountCheck } : {}),
    ...(onError ? { onError } : {})
  });
  return {
    observer,
    paymentTasks,
    clock,
    checkCalls,
    claimCalls,
    listCalls,
    failPending(id) {
      const task = taskMap.get(id);
      if (!task || task.state !== 'pending_3ds') return false;
      task.state = 'failed';
      return true;
    },
    task: id => taskMap.get(id)
  };
}

function createFakeClock(start) {
  let current = start;
  let nextHandle = 1;
  const timers = new Map();
  const cleared = [];
  return {
    get now() { return current; },
    get size() { return timers.size; },
    setTimer(callback, delay) {
      const handle = nextHandle++;
      timers.set(handle, { callback, at: current + delay });
      return handle;
    },
    clearTimer(handle) {
      const timer = timers.get(handle);
      if (timer) cleared.push(timer.callback);
      timers.delete(handle);
    },
    delays() {
      return [...timers.values()].map(timer => timer.at - current).sort((a, b) => a - b);
    },
    async advance(ms) {
      const target = current + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        current = due[1].at;
        timers.delete(due[0]);
        await due[1].callback();
      }
      current = target;
    },
    async fireDueConcurrently(ms) {
      current += ms;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= current);
      for (const [handle] of due) timers.delete(handle);
      await Promise.all(due.map(([, timer]) => timer.callback()));
    },
    async deliverLastCleared() {
      await cleared.at(-1)?.();
    }
  };
}
