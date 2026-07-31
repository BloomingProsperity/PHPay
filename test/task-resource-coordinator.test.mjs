import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProxyLeaseRegistry,
  createResourceWakeSignal,
  createTaskResourceCoordinator
} from '../src/task-resource-coordinator.js';

test('leases healthy proxies top-to-bottom without concurrent reuse', () => {
  const coordinator = createTaskResourceCoordinator({
    proxies: ['http://one.test:8001/', 'http://two.test:8002/', 'http://three.test:8003/']
  });
  for (let index = 0; index < 3; index++) coordinator.markProxyHealth(index, { ok: true, latencyMs: 10 + index });

  const first = coordinator.acquireProxy({ ownerId: 'task-1', cursor: 0 });
  const second = coordinator.acquireProxy({ ownerId: 'task-2', cursor: 0 });
  assert.deepEqual(first, {
    direct: false,
    index: 0,
    proxy: 'http://one.test:8001/',
    nextCursor: 1
  });
  assert.equal(second.index, 1);

  coordinator.releaseProxy('task-1');
  const third = coordinator.acquireProxy({ ownerId: 'task-3', cursor: 0 });
  assert.equal(third.index, 0);
});

test('skips failed and stale proxy health results', () => {
  let now = 1_000;
  const coordinator = createTaskResourceCoordinator({
    proxies: ['http://one.test:8001/', 'http://two.test:8002/'],
    healthTtlMs: 120_000,
    now: () => now
  });
  coordinator.markProxyHealth(0, { ok: false, error: 'proxy_connection_failed' });
  coordinator.markProxyHealth(1, { ok: true, latencyMs: 30 });

  assert.equal(coordinator.acquireProxy({ ownerId: 'task-1', cursor: 0 }).index, 1);
  coordinator.releaseProxy('task-1');
  now += 120_001;
  assert.equal(coordinator.acquireProxy({ ownerId: 'task-2', cursor: 0 }), null);
  assert.deepEqual(coordinator.indicesNeedingHealthCheck(), [0, 1]);
});

test('direct mode never limits concurrency or creates proxy leases', () => {
  const coordinator = createTaskResourceCoordinator({ proxies: [] });
  const first = coordinator.acquireProxy({ ownerId: 'task-1', cursor: 0 });
  const second = coordinator.acquireProxy({ ownerId: 'task-2', cursor: 0 });

  assert.deepEqual(first, { direct: true, index: -1, proxy: '', nextCursor: 0 });
  assert.deepEqual(second, first);
  assert.deepEqual(coordinator.publicStats(), {
    direct: true,
    total: 0,
    healthy: 0,
    unavailable: 0,
    unchecked: 0,
    inUse: 0
  });
});

test('waiters are woken by health and release events without interval polling', async () => {
  const coordinator = createTaskResourceCoordinator({
    proxies: ['http://one.test:8001/']
  });
  const firstWait = coordinator.waitForChange();
  coordinator.markProxyHealth(0, { ok: true });
  assert.equal(await firstWait, 'health');

  coordinator.acquireProxy({ ownerId: 'task-1', cursor: 0 });
  const secondWait = coordinator.waitForChange();
  coordinator.releaseProxy('task-1');
  assert.equal(await secondWait, 'release');
});

test('independent deployment coordinators never share leases or health', () => {
  const proxies = ['http://one.test:8001/'];
  const first = createTaskResourceCoordinator({ proxies });
  const second = createTaskResourceCoordinator({ proxies });
  first.markProxyHealth(0, { ok: true });

  assert.equal(second.acquireProxy({ ownerId: 'task-2', cursor: 0 }), null);
  second.markProxyHealth(0, { ok: true });
  assert.equal(first.acquireProxy({ ownerId: 'task-1', cursor: 0 }).index, 0);
  assert.equal(second.acquireProxy({ ownerId: 'task-2', cursor: 0 }).index, 0);
});

test('coordinators in one deployment share a hard proxy lease registry', () => {
  const registry = createProxyLeaseRegistry();
  const proxies = ['http://one.test:8001/', 'http://two.test:8002/'];
  const first = createTaskResourceCoordinator({ proxies, leaseRegistry: registry });
  const second = createTaskResourceCoordinator({ proxies, leaseRegistry: registry });
  for (const coordinator of [first, second]) {
    coordinator.markProxyHealth(0, { ok: true });
    coordinator.markProxyHealth(1, { ok: true });
  }

  assert.equal(first.acquireProxy({ ownerId: 'task-1', cursor: 0 }).index, 0);
  assert.equal(second.acquireProxy({ ownerId: 'task-2', cursor: 0 }).index, 1);
  assert.equal(second.releaseProxy('task-2'), true);
  assert.equal(first.releaseProxy('task-1'), true);
});

test('generic resource wake signals release one FIFO waiter per resource event', async () => {
  const signal = createResourceWakeSignal();
  const order = [];
  const first = signal.wait().then(reason => order.push(`first:${reason}`));
  const second = signal.wait().then(reason => order.push(`second:${reason}`));

  assert.equal(signal.notify('card_release'), true);
  await first;
  assert.deepEqual(order, ['first:card_release']);
  assert.equal(signal.notify('address_release'), true);
  await second;
  assert.deepEqual(order, ['first:card_release', 'second:address_release']);
});
