import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IMPERSONATION } from '../src/fprints.js';
import { createFingerprintProvider } from '../src/fingerprint-provider.js';

test('default provider preserves the current impersonation behavior', () => {
  const provider = createFingerprintProvider();
  const selected = provider.acquire({ ownerId: 'task-1', ordinal: 0 });

  assert.equal(selected.impersonation, DEFAULT_IMPERSONATION);
  assert.equal(selected.reused, false);
  assert.deepEqual(provider.publicView(), {
    mode: 'default',
    count: 1,
    items: [{ id: 'fp_default', label: `Default / ${DEFAULT_IMPERSONATION}` }]
  });
});

test('prefers unused profiles in top-to-bottom order and softly reuses after exhaustion', () => {
  const provider = createFingerprintProvider({
    profiles: [
      { id: 'fp-1', label: 'One', impersonation: 'chrome-one' },
      { id: 'fp-2', label: 'Two', impersonation: 'chrome-two' },
      { id: 'fp-3', label: 'Three', impersonation: 'chrome-three' }
    ]
  });

  assert.equal(provider.acquire({ ownerId: 'task-1', ordinal: 0 }).id, 'fp-1');
  assert.equal(provider.acquire({ ownerId: 'task-2', ordinal: 0 }).id, 'fp-2');
  assert.equal(provider.acquire({ ownerId: 'task-3', ordinal: 0 }).id, 'fp-3');
  assert.deepEqual(
    provider.acquire({ ownerId: 'task-4', ordinal: 0 }),
    {
      id: 'fp-1',
      label: 'One',
      impersonation: 'chrome-one',
      userAgent: '',
      headers: {},
      metadata: {},
      reused: true
    }
  );
});

test('release removes only that owner and lets a later task prefer the free profile', () => {
  const provider = createFingerprintProvider({
    profiles: [
      { id: 'fp-1', label: 'One', impersonation: 'chrome-one' },
      { id: 'fp-2', label: 'Two', impersonation: 'chrome-two' }
    ]
  });
  provider.acquire({ ownerId: 'task-1', ordinal: 0 });
  provider.acquire({ ownerId: 'task-2', ordinal: 1 });
  assert.equal(provider.release('task-1'), true);

  const selected = provider.acquire({ ownerId: 'task-3', ordinal: 0 });
  assert.equal(selected.id, 'fp-1');
  assert.equal(selected.reused, false);
});

test('snapshot is stable and public views never expose private fingerprint fields', () => {
  const provider = createFingerprintProvider({
    profiles: [{
      id: 'fp-private',
      label: 'Private',
      impersonation: 'chrome-private',
      userAgent: 'private-user-agent',
      headers: { 'x-private': 'secret' },
      metadata: { secret: 'value' }
    }]
  });

  const snapshot = provider.snapshot();
  snapshot[0].headers['x-private'] = 'changed';

  assert.equal(provider.snapshot()[0].headers['x-private'], 'secret');
  assert.doesNotMatch(JSON.stringify(provider.publicView()), /secret|private-user-agent|x-private/);
});

test('two providers remain isolated for independent Docker deployments', () => {
  const profiles = [{ id: 'fp-1', label: 'One', impersonation: 'chrome-one' }];
  const first = createFingerprintProvider({ profiles });
  const second = createFingerprintProvider({ profiles });

  first.acquire({ ownerId: 'first-task', ordinal: 0 });
  assert.equal(second.acquire({ ownerId: 'second-task', ordinal: 0 }).reused, false);
});
