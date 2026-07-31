import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAccountCredential, stableAccountKey } from '../src/account-identity.js';

test('same normalized email keeps one stable account identity across token refreshes', () => {
  assert.equal(
    stableAccountKey({
      accessToken: 'old-token',
      user: { email: ' User@Example.com ' }
    }),
    stableAccountKey({
      accessToken: 'fresh-token',
      user: { email: 'user@example.com' }
    })
  );
});

test('credential merge preserves resource metadata and replaces refreshed credential fields', () => {
  const merged = mergeAccountCredential({
    accessToken: 'old-token',
    sessionToken: 'old-session',
    user: { email: 'user@example.com', name: 'Old Name' },
    _resource: { id: 'accounts_existing', payment: { state: 'completed' } }
  }, {
    accessToken: 'fresh-token',
    sessionToken: 'fresh-session',
    user: { email: 'USER@example.com' }
  });

  assert.equal(merged.accessToken, 'fresh-token');
  assert.equal(merged.sessionToken, 'fresh-session');
  assert.equal(merged.user.email, 'USER@example.com');
  assert.equal(merged.user.name, 'Old Name');
  assert.equal(merged._resource.id, 'accounts_existing');
  assert.equal(merged._resource.payment.state, 'completed');
});
