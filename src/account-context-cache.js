const cacheableStates = new Set(['free', 'active']);

export function createAccountContextCache({
  ttlMs = 120_000,
  now = Date.now
} = {}) {
  const entries = new Map();

  const freshValue = id => {
    const entry = entries.get(String(id || ''));
    if (!entry?.value || entry.expiresAt <= now()) {
      if (entry?.value && !entry.promise) entries.delete(String(id || ''));
      return null;
    }
    return entry.value;
  };

  const load = (id, loader) => {
    const key = String(id || '');
    if (!key) return Promise.reject(new Error('account context id is required'));
    if (typeof loader !== 'function') return Promise.reject(new Error('account context loader is required'));

    const cached = freshValue(key);
    if (cached) return Promise.resolve(cached);

    const current = entries.get(key);
    if (current?.promise) return current.promise;

    const promise = Promise.resolve()
      .then(loader)
      .then(value => {
        if (cacheableStates.has(String(value?.status?.state || ''))) {
          entries.set(key, {
            value,
            expiresAt: now() + Math.max(0, Number(ttlMs) || 0),
            promise: null
          });
        } else {
          entries.delete(key);
        }
        return value;
      })
      .catch(error => {
        entries.delete(key);
        throw error;
      });

    entries.set(key, { value: null, expiresAt: 0, promise });
    return promise;
  };

  return {
    load,
    peek: freshValue,
    prime(id, value) {
      const key = String(id || '');
      if (!key || !cacheableStates.has(String(value?.status?.state || ''))) {
        if (key) entries.delete(key);
        return false;
      }
      entries.set(key, {
        value,
        expiresAt: now() + Math.max(0, Number(ttlMs) || 0),
        promise: null
      });
      return true;
    },
    invalidate(id) {
      entries.delete(String(id || ''));
    },
    clear() {
      entries.clear();
    }
  };
}
