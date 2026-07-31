import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResourceFile } from '../src/resource-importers.js';

test('cards accept only documented pipe TXT records and reject malformed rows', () => {
  const result = parseResourceFile('cards', {
    name: 'cards.txt',
    text: '4242424242424242|12/30|123|Jane Doe\ninvalid'
  });

  assert.deepEqual(result.records, [
    { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Jane Doe' }
  ]);
  assert.deepEqual(result.errors, [{ line: 2, reason: 'expected number|MM/YY|CVC|name' }]);
});

test('addresses reject incomplete pipe TXT instead of accepting a zip as country', () => {
  const result = parseResourceFile('addresses', {
    name: 'addresses.txt',
    text: '123 Main St|Seattle|WA|98101'
  });

  assert.deepEqual(result.records, []);
  assert.deepEqual(result.errors, [{ line: 1, reason: 'expected five fields' }]);
});

test('addresses map explicit CSV headers without treating the header as data', () => {
  const result = parseResourceFile('addresses', {
    name: 'addresses.csv',
    text: 'street,city,state,zip,country\n1 Main St,Seattle,WA,98101,US'
  });

  assert.deepEqual(result.records, [
    { line1: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' }
  ]);
  assert.deepEqual(result.errors, []);
});

test('accounts reject JSON records without a supported token field', () => {
  const result = parseResourceFile('accounts', {
    name: 'accounts.json',
    text: JSON.stringify([{ user: { email: 'a@example.com' } }])
  });

  assert.deepEqual(result.records, []);
  assert.deepEqual(result.errors, [{ line: 1, reason: 'no recognizable account credential' }]);
});

test('accounts extract JSON, bearer, cookie and named token fields from mixed TXT', () => {
  const text = [
    'note before credentials',
    '{"accessToken":"eyJhbGci.valid.access","user":{"email":"json@example.com"}}',
    'Authorization: Bearer eyJhbGci.header.access',
    '__Secure-next-auth.session-token=eyJhbGci.cookie.session',
    'accessToken = eyJhbGci.named.access',
    'not-a-credential'
  ].join('\n');
  const result = parseResourceFile('accounts', { name: 'accounts.txt', text });

  assert.equal(result.records.length, 4);
  assert.deepEqual(result.lines, [2, 3, 4, 5]);
  assert.equal(result.records[0].user.email, 'json@example.com');
  assert.equal(result.errors.length, 0);
});

test('one session JSON keeps both credentials in one account', () => {
  const result = parseResourceFile('accounts', {
    name: 'session.json',
    text: JSON.stringify({
      accessToken: 'eyJhbGci.primary.access',
      sessionToken: 'eyJhbGci.secondary.session',
      user: { email: 'one-session@example.com' }
    })
  });

  assert.deepEqual(result.records, [{
    accessToken: 'eyJhbGci.primary.access',
    sessionToken: 'eyJhbGci.secondary.session',
    user: { email: 'one-session@example.com' }
  }]);
  assert.deepEqual(result.lines, [1]);
  assert.deepEqual(result.errors, []);
});

test('polluted session JSON recovers one access token and ignores trailing tool text', () => {
  const result = parseResourceFile('accounts', {
    name: 'polluted-session.txt',
    text: [
      '{"accessToken":"eyJhbGci..\\npolluted","sessionToken":"eyJhbGci..iv.\\ncipher.tag","user":{"email":"polluted@example.com"}}',
      '开放 ✦生成长链 账结一体机'
    ].join('\n').replaceAll('\\n', '\n')
  });

  assert.deepEqual(result.records, [{
    accessToken: 'eyJhbGci..polluted',
    sessionToken: 'eyJhbGci..iv.cipher.tag',
    user: { email: 'polluted@example.com' }
  }]);
  assert.deepEqual(result.lines, [1]);
  assert.deepEqual(result.errors, []);
});

test('accounts inspect text content regardless of a text file extension', () => {
  const result = parseResourceFile('accounts', { name: 'export.backup', text: 'accessToken=eyJhbGci.named.access' });
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.errors, []);
});

test('account TXT invalid fragments do not leak their source text', () => {
  const result = parseResourceFile('accounts', { name: 'accounts.txt', text: 'secret-token-value' });

  assert.deepEqual(result.records, []);
  assert.deepEqual(result.errors, [{ line: 1, reason: 'no recognizable account credential' }]);
  assert.doesNotMatch(JSON.stringify(result), /secret-token-value/);
});

test('cards reject month zero and expired dates', () => {
  const result = parseResourceFile('cards', {
    name: 'cards.txt',
    text: '4242424242424242|00/30|123\n4242424242424242|01/20|123'
  });

  assert.equal(result.records.length, 0);
  assert.deepEqual(result.errors.map(error => error.line), [1, 2]);
  assert.deepEqual(result.errors.map(error => error.reason), ['invalid expiration', 'expired card']);
});

test('cards accept formatted Luhn-valid numbers but reject invalid or non-card text', () => {
  const valid = parseResourceFile('cards', { name: 'cards.txt', text: '4242-4242 4242-4242|12/30|123|Jane' });
  assert.equal(valid.records.length, 1);
  assert.equal(valid.records[0].number, '4242424242424242');

  const invalid = parseResourceFile('cards', { name: 'cards.txt', text: '4242424242424241|12/30|123\ncard-4242|12/30|123' });
  assert.deepEqual(invalid.errors.map(error => error.reason), ['invalid card number', 'invalid card number']);
});

test('card TXT accepts English or full-width commas and normalizes MMYY expiration', () => {
  const result = parseResourceFile('cards', {
    name: 'cards.txt',
    text: [
      '4242424242424242,12/30,123,Jane Doe',
      '5555555555554444，1130，456'
    ].join('\n')
  });

  assert.deepEqual(result.records, [
    { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Jane Doe' },
    { number: '5555555555554444', exp: '11/30', cvc: '456', name: '' }
  ]);
  assert.deepEqual(result.errors, []);
});

test('unsupported file types fail without exposing file content', () => {
  const result = parseResourceFile('cards', { name: 'cards.xlsx', text: 'secret' });

  assert.deepEqual(result.records, []);
  assert.deepEqual(result.errors, [{ line: null, reason: 'unsupported file type: xlsx' }]);
  assert.equal(Object.hasOwn(result.errors[0], 'raw'), false);
});
