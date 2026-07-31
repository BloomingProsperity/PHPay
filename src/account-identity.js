import crypto from 'node:crypto';

export function normalizeAccountEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function stableAccountKey(account = {}) {
  const email = normalizeAccountEmail(account?.user?.email || account?.email);
  if (email) return `email:${email}`;
  const credential = String(account?.accessToken || account?.sessionToken || '').trim();
  if (!credential) return '';
  return `credential:${crypto.createHash('sha256').update(credential).digest('hex')}`;
}

export function mergeAccountCredential(current = {}, incoming = {}) {
  const merged = {
    ...current,
    ...incoming,
    user: {
      ...(current?.user && typeof current.user === 'object' ? current.user : {}),
      ...(incoming?.user && typeof incoming.user === 'object' ? incoming.user : {})
    }
  };
  for (const field of ['accessToken', 'sessionToken']) {
    const next = String(incoming?.[field] || '').trim();
    if (next) merged[field] = next;
    else if (current?.[field]) merged[field] = current[field];
    else delete merged[field];
  }
  if (current?._resource && typeof current._resource === 'object') {
    merged._resource = current._resource;
  }
  return merged;
}
