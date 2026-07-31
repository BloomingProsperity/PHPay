import { DEFAULT_IMPERSONATION } from './fprints.js';

const clone = value => JSON.parse(JSON.stringify(value));

function normalizedProfile(profile, index) {
  const impersonation = String(profile?.impersonation || '').trim();
  if (!impersonation) throw new Error(`fingerprint profile ${index + 1} is missing impersonation`);
  return {
    id: String(profile?.id || `fp_${index + 1}`).trim(),
    label: String(profile?.label || `Fingerprint ${index + 1}`).trim(),
    impersonation,
    userAgent: String(profile?.userAgent || '').trim(),
    headers: profile?.headers && typeof profile.headers === 'object' ? clone(profile.headers) : {},
    metadata: profile?.metadata && typeof profile.metadata === 'object' ? clone(profile.metadata) : {}
  };
}

export function createFingerprintProvider({
  profiles = [],
  fallbackProfile = {
    id: 'fp_default',
    label: `Default / ${DEFAULT_IMPERSONATION}`,
    impersonation: DEFAULT_IMPERSONATION
  }
} = {}) {
  const supplied = Array.isArray(profiles) ? profiles : [];
  const normalized = (supplied.length ? supplied : [fallbackProfile]).map(normalizedProfile);
  const ids = new Set();
  for (const profile of normalized) {
    if (!profile.id || ids.has(profile.id)) throw new Error('fingerprint profile ids must be unique and non-empty');
    ids.add(profile.id);
  }

  const ownersByIndex = normalized.map(() => new Set());
  const assignmentByOwner = new Map();

  const selectedView = assignment => ({
    ...clone(normalized[assignment.index]),
    reused: assignment.reused
  });

  const acquire = ({ ownerId, ordinal = 0 } = {}) => {
    const owner = String(ownerId || '').trim();
    if (!owner) throw new Error('fingerprint owner id is required');
    const existing = assignmentByOwner.get(owner);
    if (existing) return selectedView(existing);

    const start = Math.abs(Number.isFinite(Number(ordinal)) ? Math.trunc(Number(ordinal)) : 0) % normalized.length;
    let index = -1;
    for (let offset = 0; offset < normalized.length; offset++) {
      const candidate = (start + offset) % normalized.length;
      if (ownersByIndex[candidate].size === 0) {
        index = candidate;
        break;
      }
    }
    const reused = index === -1;
    if (reused) index = start;

    const assignment = { index, reused };
    assignmentByOwner.set(owner, assignment);
    ownersByIndex[index].add(owner);
    return selectedView(assignment);
  };

  return {
    snapshot() {
      return clone(normalized);
    },
    acquire,
    release(ownerId) {
      const owner = String(ownerId || '').trim();
      const assignment = assignmentByOwner.get(owner);
      if (!assignment) return false;
      assignmentByOwner.delete(owner);
      ownersByIndex[assignment.index].delete(owner);
      return true;
    },
    publicView() {
      return {
        mode: supplied.length ? 'library' : 'default',
        count: normalized.length,
        items: normalized.map(({ id, label }) => ({ id, label }))
      };
    }
  };
}
