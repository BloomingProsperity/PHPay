export function createResourceWakeSignal() {
  const waiters = [];
  return {
    wait(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason || new Error('resource wait aborted'));
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          done: false,
          cleanup: () => signal?.removeEventListener('abort', onAbort)
        };
        const onAbort = () => {
          if (waiter.done) return;
          waiter.done = true;
          waiter.cleanup();
          reject(signal.reason || new Error('resource wait aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
      });
    },
    notify(reason = 'resource') {
      while (waiters.length) {
        const waiter = waiters.shift();
        if (waiter.done) continue;
        waiter.done = true;
        waiter.cleanup();
        waiter.resolve(reason);
        return true;
      }
      return false;
    }
  };
}

export function createProxyLeaseRegistry() {
  const ownerByProxy = new Map();
  const proxyByOwner = new Map();
  const listeners = new Set();

  const notify = reason => {
    for (const listener of listeners) listener(reason);
  };

  return {
    acquire(proxy, ownerId) {
      const owner = String(ownerId || '').trim();
      const value = String(proxy || '');
      if (!owner || !value) return false;
      if (proxyByOwner.get(owner) === value) return true;
      if (proxyByOwner.has(owner) || ownerByProxy.has(value)) return false;
      proxyByOwner.set(owner, value);
      ownerByProxy.set(value, owner);
      return true;
    },
    proxyForOwner(ownerId) {
      return proxyByOwner.get(String(ownerId || '').trim()) || '';
    },
    release(ownerId) {
      const owner = String(ownerId || '').trim();
      const proxy = proxyByOwner.get(owner);
      if (!proxy) return false;
      proxyByOwner.delete(owner);
      ownerByProxy.delete(proxy);
      notify('release');
      return true;
    },
    isLeased(proxy) {
      return ownerByProxy.has(String(proxy || ''));
    },
    count(proxies = []) {
      return proxies.reduce((total, proxy) => total + (ownerByProxy.has(proxy) ? 1 : 0), 0);
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export function createTaskResourceCoordinator({
  proxies = [],
  healthTtlMs = 120_000,
  now = Date.now,
  leaseRegistry = createProxyLeaseRegistry()
} = {}) {
  const pool = Array.isArray(proxies) ? [...proxies] : [];
  const health = new Map();
  const waiters = [];

  const freshHealth = index => {
    const result = health.get(index);
    if (!result || result.checkedAt + Math.max(0, Number(healthTtlMs) || 0) < now()) return null;
    return result;
  };

  const notifyOne = reason => {
    while (waiters.length) {
      const waiter = waiters.shift();
      if (waiter.done) continue;
      waiter.done = true;
      waiter.cleanup();
      waiter.resolve(reason);
      break;
    }
  };
  const unsubscribe = leaseRegistry.subscribe(reason => notifyOne(reason));

  const acquireProxy = ({ ownerId, cursor = 0 } = {}) => {
    if (!pool.length) return { direct: true, index: -1, proxy: '', nextCursor: 0 };
    const owner = String(ownerId || '').trim();
    if (!owner) throw new Error('proxy owner id is required');

    const existingProxy = leaseRegistry.proxyForOwner(owner);
    const existing = pool.indexOf(existingProxy);
    if (existing >= 0) {
      return {
        direct: false,
        index: existing,
        proxy: pool[existing],
        nextCursor: (existing + 1) % pool.length
      };
    }

    const start = Math.abs(Number.isFinite(Number(cursor)) ? Math.trunc(Number(cursor)) : 0) % pool.length;
    for (let offset = 0; offset < pool.length; offset++) {
      const index = (start + offset) % pool.length;
      if (freshHealth(index)?.ok !== true) continue;
      if (!leaseRegistry.acquire(pool[index], owner)) continue;
      return {
        direct: false,
        index,
        proxy: pool[index],
        nextCursor: (index + 1) % pool.length
      };
    }
    return null;
  };

  return {
    snapshot() {
      return [...pool];
    },
    markProxyHealth(index, result = {}) {
      const position = Number(index);
      if (!Number.isInteger(position) || position < 0 || position >= pool.length) return false;
      health.set(position, {
        ok: result.ok === true,
        latencyMs: Number.isFinite(result.latencyMs) && result.latencyMs >= 0
          ? Math.round(result.latencyMs)
          : null,
        error: result.ok === true ? '' : String(result.error || 'proxy_connection_failed'),
        checkedAt: now()
      });
      notifyOne('health');
      return true;
    },
    indicesNeedingHealthCheck() {
      return pool.map((_, index) => index).filter(index => !freshHealth(index));
    },
    acquireProxy,
    releaseProxy(ownerId) {
      return leaseRegistry.release(ownerId);
    },
    waitForChange(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason || new Error('resource wait aborted'));
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          done: false,
          cleanup: () => signal?.removeEventListener('abort', onAbort)
        };
        const onAbort = () => {
          if (waiter.done) return;
          waiter.done = true;
          waiter.cleanup();
          reject(signal.reason || new Error('resource wait aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
      });
    },
    publicStats() {
      let healthy = 0, unavailable = 0, unchecked = 0;
      for (let index = 0; index < pool.length; index++) {
        const result = freshHealth(index);
        if (!result) unchecked++;
        else if (result.ok) healthy++;
        else unavailable++;
      }
      return {
        direct: pool.length === 0,
        total: pool.length,
        healthy,
        unavailable,
        unchecked,
        inUse: leaseRegistry.count(pool)
      };
    },
    close() {
      unsubscribe();
    }
  };
}
