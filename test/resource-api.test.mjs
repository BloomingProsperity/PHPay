import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaymentTaskStore } from '../src/payment-task-store.js';
import { createResourceStore } from '../src/resource-store.js';

async function withServer(run, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-resource-api-'));
  const auditFile = path.join(root, 'test-audit.jsonl');
  const port = 43000 + Math.floor(Math.random() * 1000);
  await options.setup?.(root);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DIPAY_STORAGE_ROOT: root,
      DIPAY_DISABLE_ACCOUNT_STATUS_CHECK: '1',
      DIPAY_DISABLE_PAYMENT_EXECUTION: '1',
      DIPAY_TEST_AUDIT_FILE: auditFile,
      DIPAY_FAKE_PROXY_TEST: '1',
      DIPAY_FAKE_PROXY_TEST_DELAY_MS: '0',
      PROXY_POOL: 'http://proxy-slot-0.invalid,http://proxy-slot-1.invalid',
      ...options.env
    },
    stdio: options.stdio || ['ignore', 'ignore', 'ignore']
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
      if (attempt === 49) throw new Error('isolated server did not start');
    }
    return await run(base, root, () => readAudit(auditFile));
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readAudit(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function waitFor(read, predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test('strict card import reports file-local counts and list results stay redacted', async () => withServer(async base => {
  const response = await fetch(`${base}/api/resources/cards/import`, {
    method: 'POST',
    body: JSON.stringify({ file: { name: 'cards.txt', text: '4242424242424242|12/30|123|Jane Doe' } })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { file: 'cards.txt', added: 1, duplicate: 0, errors: [] });

  const list = await (await fetch(`${base}/api/cards`)).json();
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'importedAt', 'masked', 'name', 'usage']);
  assert.deepEqual(list[0].usage, {
    state: 'available',
    paidAccountCount: 0,
    attemptCount: 0,
    successCount: 0,
    threeDsCount: 0,
    hasThreeDs: false
  });
  assert.equal(list[0].masked, '•••• 4242');
}));

test('legacy import routes are retired so they cannot bypass strict parsing', async () => withServer(async base => {
  const response = await fetch(`${base}/api/cards/import`, {
    method: 'POST',
    body: JSON.stringify({ cards: '4242424242424242|12/30|123' })
  });
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), { error: 'use /api/resources/:kind/import' });
}));

test('invalid resource rows are rejected without a filesystem write', async () => withServer(async (base, root) => {
  const response = await fetch(`${base}/api/resources/addresses/import`, {
    method: 'POST',
    body: JSON.stringify({ file: { name: 'addresses.txt', text: '123 Main St|Seattle|WA|98101' } })
  });
  assert.deepEqual(await response.json(), {
    file: 'addresses.txt', added: 0, duplicate: 0,
    errors: [{ line: 1, reason: 'expected five fields' }]
  });
  assert.equal(fs.existsSync(path.join(root, 'addresses')), false);
}));

test('temporary addresses do not persist until explicitly imported', async () => withServer(async base => {
  const temporary = await (await fetch(`${base}/api/addresses/temporary`, { method: 'POST' })).json();
  assert.equal(temporary.temporary, true);
  assert.match(temporary.line1, /\S/);
  assert.equal((await (await fetch(`${base}/api/addresses`)).json()).length, 0);

  const saved = await (await fetch(`${base}/api/resources/addresses/import`, {
    method: 'POST',
    body: JSON.stringify({ file: { name: 'temporary-address.json', text: JSON.stringify(temporary) } })
  })).json();
  assert.equal(saved.added, 1);
  assert.equal((await (await fetch(`${base}/api/addresses`)).json()).length, 1);
}));

test('single payment generates a temporary address when no address is selected or supplied', async () => withServer(async (base, root, audit) => {
  await fetch(`${base}/api/resources/accounts/import`, {
    method: 'POST',
    body: JSON.stringify({
      file: {
        name: 'account.json',
        text: JSON.stringify({
          accessToken: 'eyJhbGci.temporary.address',
          user: { email: 'temporary-address@example.com' }
        })
      }
    })
  });
  await fetch(`${base}/api/resources/cards/import`, {
    method: 'POST',
    body: JSON.stringify({
      file: { name: 'card.txt', text: '4242424242424242|12/30|123|Temp Address' }
    })
  });
  const store = createResourceStore(root);
  const [account] = store.list('accounts');
  store.updateAccountStatus(account.id, { state: 'free', plan: 'chatgptfreeplan' });
  const [card] = store.list('cards');

  const response = await fetch(`${base}/api/payment-tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'temporary-address-single-0001'
    },
    body: JSON.stringify({
      accountResourceId: account.id,
      cardResourceId: card.id,
      plan: 'chatgptplusplan'
    })
  });
  assert.equal(response.status, 202);
  const task = await response.json();
  assert.equal(createPaymentTaskStore(root).getInternal(task.id).addressResourceId, '');
  const events = await waitFor(audit, rows => rows.some(row => row.type === 'payment-start'));
  assert.match(events.find(row => row.type === 'payment-start').city, /\S/);
  assert.equal(store.list('addresses').length, 0);
}, {
  env: {
    DIPAY_FAKE_ACCOUNT_STATUS_CHECK: '1',
    DIPAY_FAKE_ACCOUNT_STATUS_STATE: 'free'
  }
}));

test('mixed account TXT imports valid candidates without exposing credential text', async () => withServer(async base => {
  const text = 'Authorization: Bearer eyJhbGci.header.access\naccessToken=eyJhbGci.named.access';
  const response = await fetch(`${base}/api/resources/accounts/import`, {
    method: 'POST', body: JSON.stringify({ file: { name: 'accounts.txt', text } })
  });
  const result = await response.json();
  assert.equal(result.added, 2);
  assert.doesNotMatch(JSON.stringify(result), /eyJhbGci/);
}));

test('pasted account detection imports valid accounts, refreshes duplicates, and rejects invalid input', async () => withServer(async base => {
  const validText = `${JSON.stringify({
    accessToken: 'eyJhbGci.pasted.valid',
    sessionToken: 'eyJhbGci.pasted.session',
    user: { email: 'pasted@example.com' }
  }).replace('pasted.valid', 'pasted.\nvalid')}\n开放 ✦生成长链 账结一体机`;
  const firstResponse = await fetch(`${base}/api/resources/accounts/detect-import`, {
    method: 'POST',
    body: JSON.stringify({ text: validText })
  });
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.added, 1);
  assert.equal(first.duplicate, 0);
  assert.equal(first.rejected, 0);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].label, 'pasted@example.com');
  assert.equal(first.items[0].accountStatus.state, 'free');
  assert.doesNotMatch(JSON.stringify(first), /eyJhbGci/);
  assert.equal((await (await fetch(`${base}/api/accounts`)).json()).length, 1);

  const duplicate = await (await fetch(`${base}/api/resources/accounts/detect-import`, {
    method: 'POST',
    body: JSON.stringify({ text: validText })
  })).json();
  assert.equal(duplicate.added, 0);
  assert.equal(duplicate.duplicate, 1);
  assert.equal(duplicate.items[0].accountStatus.state, 'free');
  assert.equal((await (await fetch(`${base}/api/accounts`)).json()).length, 1);

  const invalid = await (await fetch(`${base}/api/resources/accounts/detect-import`, {
    method: 'POST',
    body: JSON.stringify({ text: 'this is not an account credential' })
  })).json();
  assert.equal(invalid.added, 0);
  assert.equal(invalid.rejected, 1);
  assert.equal(invalid.items.length, 0);
  assert.equal((await (await fetch(`${base}/api/accounts`)).json()).length, 1);
}, {
  env: {
    DIPAY_DISABLE_ACCOUNT_STATUS_CHECK: '0',
    DIPAY_FAKE_ACCOUNT_STATUS_CHECK: '1',
    DIPAY_FAKE_ACCOUNT_STATUS_STATE: 'free',
    DIPAY_FAKE_ACCOUNT_STATUS_PLAN: 'chatgptfreeplan'
  }
}));

test('file account import rejects credentials that fail the same status policy as pasted import', async () => withServer(async base => {
  const response = await fetch(`${base}/api/resources/accounts/import`, {
    method: 'POST',
    body: JSON.stringify({
      file: {
        name: 'invalid-account.json',
        text: JSON.stringify({
          accessToken: 'eyJhbGci.invalid.access',
          user: { email: 'invalid@example.com' }
        })
      }
    })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.added, 0);
  assert.equal(result.duplicate, 0);
  assert.equal(result.rejected, 1);
  assert.equal(result.items.length, 0);
  assert.equal((await (await fetch(`${base}/api/accounts`)).json()).length, 0);
}, {
  env: {
    DIPAY_DISABLE_ACCOUNT_STATUS_CHECK: '0',
    DIPAY_FAKE_ACCOUNT_STATUS_CHECK: '1',
    DIPAY_FAKE_ACCOUNT_STATUS_STATE: 'invalid',
    DIPAY_FAKE_ACCOUNT_STATUS_PLAN: ''
  }
}));

test('an immediate payment reuses the import-time account check instead of starting a duplicate check', async () => withServer(async (base, _root, audit) => {
  await fetch(`${base}/api/resources/accounts/import`, {
    method: 'POST',
    body: JSON.stringify({
      file: {
        name: 'account.json',
        text: JSON.stringify({
          accessToken: 'eyJhbGci.fast.access',
          user: { email: 'fast@example.com' }
        })
      }
    })
  });
  await fetch(`${base}/api/resources/cards/import`, {
    method: 'POST',
    body: JSON.stringify({
      file: { name: 'card.txt', text: '4242424242424242|12/30|123|Fast User' }
    })
  });
  await fetch(`${base}/api/resources/addresses/import`, {
    method: 'POST',
    body: JSON.stringify({
      file: { name: 'address.txt', text: '1 Main St|Seattle|WA|98101|US' }
    })
  });
  const [account] = await (await fetch(`${base}/api/accounts`)).json();
  const [card] = await (await fetch(`${base}/api/cards`)).json();
  const [address] = await (await fetch(`${base}/api/addresses`)).json();

  const response = await fetch(`${base}/api/payment-tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'fast-account-context-0001'
    },
    body: JSON.stringify({
      accountResourceId: account.id,
      cardResourceId: card.id,
      addressResourceId: address.id,
      plan: 'chatgptpro'
    })
  });
  assert.equal(response.status, 202);
  const task = await response.json();
  assert.equal(task.fingerprintId, 'fp_builtin_1');
  assert.equal(task.fingerprintLabel, 'Built-in / edge99');
  assert.equal(task.fingerprintReused, false);

  const events = await waitFor(
    audit,
    rows => rows.some(row => row.type === 'account-check-end')
      && rows.some(row => row.type === 'payment-start'),
    'import check and simulated payment did not finish'
  );
  assert.equal(events.filter(row => row.type === 'account-check-start').length, 1);
  assert.equal(events.find(row => row.type === 'payment-start').accountContext, 'cached_or_coalesced');
}, {
  env: {
    DIPAY_DISABLE_ACCOUNT_STATUS_CHECK: '0',
    DIPAY_FAKE_ACCOUNT_STATUS_CHECK: '1',
    DIPAY_FAKE_ACCOUNT_STATUS_DELAY_MS: '80'
  }
}));

test('batch payment starts with one reusable card and generated temporary addresses', async () => withServer(async (base, root) => {
  await fetch(`${base}/api/resources/accounts/import`, { method: 'POST', body: JSON.stringify({ file: { name: 'account.json', text: JSON.stringify({ accessToken: 'eyJhbGci.fake.access', user: { email: 'safe@example.com' } }) } }) });
  await fetch(`${base}/api/resources/cards/import`, { method: 'POST', body: JSON.stringify({ file: { name: 'card.txt', text: '4242424242424242|12/30|123|Jane Doe' } }) });
  const [account] = createResourceStore(root).list('accounts');
  createResourceStore(root).updateAccountStatus(account.id, { state: 'free', plan: 'chatgptfreeplan' });
  const response = await fetch(`${base}/api/payment-tasks/batch`, { method: 'POST', body: JSON.stringify({ plan: 'chatgptpro', concurrency: 2 }) });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.total, 1);
  assert.equal(body.state, 'processing');
}));

test('batch preflight tests proxies concurrently and skips a failed proxy before task start', async () => withServer(async (base, root, audit) => {
  await fetch(`${base}/api/resources/accounts/import`, {
    method: 'POST',
    body: JSON.stringify({
      file: {
        name: 'account.json',
        text: JSON.stringify({
          accessToken: 'eyJhbGci.proxy.access',
          user: { email: 'proxy@example.com' }
        })
      }
    })
  });
  await fetch(`${base}/api/resources/cards/import`, {
    method: 'POST',
    body: JSON.stringify({
      file: { name: 'card.txt', text: '4242424242424242|12/30|123|Proxy User' }
    })
  });
  const [account] = createResourceStore(root).list('accounts');
  createResourceStore(root).updateAccountStatus(account.id, {
    state: 'free',
    plan: 'chatgptfreeplan'
  });

  const response = await fetch(`${base}/api/payment-tasks/batch`, {
    method: 'POST',
    body: JSON.stringify({ plan: 'chatgptpro', concurrency: 2 })
  });
  assert.equal(response.status, 202);

  const events = await waitFor(
    audit,
    rows => rows.filter(row => row.type === 'proxy-test-end').length === 2
      && rows.some(row => row.type === 'payment-start'),
    'proxy preflight or simulated payment did not finish'
  );
  assert.equal(Math.max(...events.filter(row => row.type === 'proxy-test-start').map(row => row.active)), 2);
  assert.match(events.find(row => row.type === 'payment-start').proxy, /healthy\.invalid/);
}, {
  env: {
    PROXY_POOL: 'http://dead.invalid:8001,http://healthy.invalid:8002',
    DIPAY_FAKE_PROXY_TEST: '1',
    DIPAY_FAKE_PROXY_TEST_DELAY_MS: '40'
  }
}));

test('single payment also preflights the ordered proxy pool and skips a failed first proxy', async () => withServer(async (base, root, audit) => {
  await fetch(`${base}/api/resources/accounts/import`, {
    method: 'POST',
    body: JSON.stringify({
      file: {
        name: 'account.json',
        text: JSON.stringify({
          accessToken: 'eyJhbGci.single.proxy',
          user: { email: 'single-proxy@example.com' }
        })
      }
    })
  });
  await fetch(`${base}/api/resources/cards/import`, {
    method: 'POST',
    body: JSON.stringify({
      file: { name: 'card.txt', text: '4242424242424242|12/30|123|Proxy User' }
    })
  });
  const [account] = createResourceStore(root).list('accounts');
  createResourceStore(root).updateAccountStatus(account.id, {
    state: 'free',
    plan: 'chatgptfreeplan'
  });
  const [card] = await (await fetch(`${base}/api/cards`)).json();
  const temporary = await (await fetch(`${base}/api/addresses/temporary`, { method: 'POST' })).json();

  const response = await fetch(`${base}/api/payment-tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'single-proxy-preflight-0001'
    },
    body: JSON.stringify({
      accountResourceId: account.id,
      cardResourceId: card.id,
      address: temporary,
      plan: 'chatgptpro'
    })
  });
  assert.equal(response.status, 202);
  const events = await waitFor(
    audit,
    rows => rows.filter(row => row.type === 'proxy-test-end').length === 2
      && rows.some(row => row.type === 'payment-start'),
    'single proxy preflight did not finish'
  );
  assert.match(events.find(row => row.type === 'payment-start').proxy, /healthy\.invalid/);
}, {
  env: {
    PROXY_POOL: 'http://dead.invalid:8001,http://healthy.invalid:8002',
    DIPAY_FAKE_PROXY_TEST: '1'
  }
}));

test('concurrent single payments cannot share the same hard-leased proxy', async () => withServer(async (base, root) => {
  for (const [index, email] of ['lease-one@example.com', 'lease-two@example.com'].entries()) {
    await fetch(`${base}/api/resources/accounts/import`, {
      method: 'POST',
      body: JSON.stringify({
        file: {
          name: `account-${index}.json`,
          text: JSON.stringify({
            accessToken: `eyJhbGci.lease.${index}`,
            user: { email }
          })
        }
      })
    });
  }
  await fetch(`${base}/api/resources/cards/import`, {
    method: 'POST',
    body: JSON.stringify({
      file: {
        name: 'cards.txt',
        text: [
          '4242424242424242|12/30|123|Lease One',
          '5555555555554444|12/30|123|Lease Two'
        ].join('\n')
      }
    })
  });
  const accounts = createResourceStore(root).list('accounts');
  const cards = createResourceStore(root).list('cards');
  const temporary = await (await fetch(`${base}/api/addresses/temporary`, { method: 'POST' })).json();
  const request = index => fetch(`${base}/api/payment-tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `single-hard-proxy-${index}-0001`
    },
    body: JSON.stringify({
      accountResourceId: accounts[index].id,
      cardResourceId: cards[index].id,
      address: temporary,
      plan: 'chatgptpro'
    })
  });

  const firstPromise = request(0);
  await new Promise(resolve => setTimeout(resolve, 30));
  const secondPromise = request(1);
  const responses = await Promise.all([firstPromise, secondPromise]);
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  const busy = await responses.find(response => response.status === 409).json();
  assert.equal(busy.errorCode, 'proxy_in_use');
}, {
  env: {
    PROXY_POOL: 'http://single-proxy.invalid:8001',
    DIPAY_DISABLE_ACCOUNT_STATUS_CHECK: '0',
    DIPAY_FAKE_ACCOUNT_STATUS_CHECK: '1',
    DIPAY_FAKE_ACCOUNT_STATUS_DELAY_MS: '250'
  }
}));

test('selected resources are locked before a payment task can start', async () => withServer(async (base, root) => {
  await fetch(`${base}/api/resources/accounts/import`, { method: 'POST', body: JSON.stringify({ file: { name: 'account.json', text: JSON.stringify({ accessToken: 'eyJhbGci.fake.access', user: { email: 'safe@example.com' } }) } }) });
  await fetch(`${base}/api/resources/cards/import`, { method: 'POST', body: JSON.stringify({ file: { name: 'card.txt', text: '4242424242424242|12/30|123|Jane Doe' } }) });
  await fetch(`${base}/api/resources/addresses/import`, { method: 'POST', body: JSON.stringify({ file: { name: 'address.txt', text: '1 Main St|Seattle|WA|98101|US' } }) });
  const [account] = await (await fetch(`${base}/api/accounts`)).json();
  const [card] = await (await fetch(`${base}/api/cards`)).json();
  const [address] = await (await fetch(`${base}/api/addresses`)).json();
  createResourceStore(root).updateAccountStatus(account.id, { state: 'free', plan: 'chatgptfreeplan' });
  assert.equal(createResourceStore(root).reserve('cards', card.id, 'another-task'), true);
  const response = await fetch(`${base}/api/payment-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'lock-test-key-0001' },
    body: JSON.stringify({ sessionJson: 'eyJhbGci.fake.access', accountResourceId: account.id, cardResourceId: card.id, addressResourceId: address.id, card: { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Jane Doe' }, address: { line1: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' }, plan: 'chatgptpro' })
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).errorCode, 'resource_in_use');
  assert.equal(createResourceStore(root).list('accounts').find(item => item.id === account.id).usage, undefined);
}));

test('selected resource accounts must be confirmed free before payment', async () => withServer(async (base, root) => {
  await fetch(`${base}/api/resources/accounts/import`, { method: 'POST', body: JSON.stringify({ file: { name: 'account.json', text: JSON.stringify({ accessToken: 'eyJhbGci.active.access', user: { email: 'active@example.com' } }) } }) });
  await fetch(`${base}/api/resources/cards/import`, { method: 'POST', body: JSON.stringify({ file: { name: 'card.txt', text: '4242424242424242|12/30|123|Jane Doe' } }) });
  const [account] = createResourceStore(root).list('accounts');
  createResourceStore(root).updateAccountStatus(account.id, { state: 'active', plan: 'chatgptplusplan' });
  const [card] = await (await fetch(`${base}/api/cards`)).json();
  const temporary = await (await fetch(`${base}/api/addresses/temporary`, { method: 'POST' })).json();

  const response = await fetch(`${base}/api/payment-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'active-account-test-key' },
    body: JSON.stringify({
      sessionJson: JSON.stringify(createResourceStore(root).get('accounts', account.id)),
      accountResourceId: account.id,
      cardResourceId: card.id,
      card: { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Jane Doe' },
      address: temporary,
      plan: 'chatgptplusplan'
    })
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'selected account is not eligible for payment');
  assert.equal(fs.existsSync(path.join(root, 'payment-tasks')), false);
}));

test('single payment uses authoritative resource records and persists slot zero privately', async () => withServer(async (base, root, audit) => {
  const store = createResourceStore(root);
  const account = store.add('accounts', { accessToken: 'eyJhbGci.server.account', user: { email: 'server@example.com' } });
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Server Card' });
  const address = store.add('addresses', { line1: '1 Server St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' });
  store.updateAccountStatus(account.id, { state: 'free', plan: 'chatgptfreeplan' });

  const response = await fetch(`${base}/api/payment-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'authoritative-resource-test' },
    body: JSON.stringify({
      sessionJson: JSON.stringify({ accessToken: 'eyJhbGci.client.account', user: { email: 'client@example.com' } }),
      accountResourceId: account.id,
      cardResourceId: card.id,
      addressResourceId: address.id,
      card: { number: '4000000000000002', exp: '01/31', cvc: '999', name: 'Client Card' },
      address: { line1: '9 Client St', city: 'Portland', state: 'OR', zip: '97201', country: 'US' },
      plan: 'chatgptpro',
      proxy: 'http://client-proxy.invalid',
      imp: 'client-fingerprint'
    })
  });

  assert.equal(response.status, 202);
  const task = await response.json();
  assert.equal(task.cardLast4, '4242');
  assert.equal(Object.hasOwn(task, 'networkSlot'), false);
  const internal = createPaymentTaskStore(root).getInternal(task.id);
  assert.equal(internal.networkSlot, 0);
  assert.equal(internal.accountResourceId, account.id);
  assert.equal(internal.cardResourceId, card.id);
  assert.equal(internal.addressResourceId, address.id);
  const events = await waitFor(audit, rows => rows.some(row => row.type === 'payment-start'));
  const used = events.find(row => row.type === 'payment-start');
  assert.deepEqual(
    { email: used.email, cardLast4: used.cardLast4, city: used.city, networkSlot: used.networkSlot, proxy: used.proxy },
    { email: 'server@example.com', cardLast4: '4242', city: 'Seattle', networkSlot: 0, proxy: 'http://proxy-slot-0.invalid/' }
  );
  assert.notEqual(used.imp, 'client-fingerprint');
}));

test('a supplied resource id must exist even when a client copy is present', async () => withServer(async base => {
  const response = await fetch(`${base}/api/payment-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'missing-resource-test-key' },
    body: JSON.stringify({
      sessionJson: 'eyJhbGci.client.account',
      accountResourceId: 'accounts_aaaaaaaaaaaaaaaaaaaaaaaa',
      card: { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Client Card' },
      address: { line1: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' }
    })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /selected accounts resource not found/);
}));

test('recheck uses the stored task slot and authoritative account while ignoring client network overrides', async () => withServer(async (base, root, audit) => {
  const resources = createResourceStore(root);
  const account = resources.add('accounts', { accessToken: 'eyJhbGci.recheck.server', user: { email: 'recheck@example.com' } });
  const tasks = createPaymentTaskStore(root);
  const task = tasks.create({
    idempotencyKey: 'recheck-network-slot',
    state: 'unknown',
    accountResourceId: account.id,
    networkSlot: 1
  });
  tasks.update(task.id, { checkoutSessionId: 'cs_recheck', processorEntity: 'openai_llc' });

  const response = await fetch(`${base}/api/payment-tasks/${task.id}/recheck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionJson: JSON.stringify({ accessToken: 'eyJhbGci.recheck.client', user: { email: 'wrong@example.com' } }),
      proxy: 'http://client-proxy.invalid',
      imp: 'client-fingerprint'
    })
  });
  assert.equal(response.status, 200);
  const events = await waitFor(audit, rows => rows.some(row => row.type === 'payment-recheck'));
  const used = events.find(row => row.type === 'payment-recheck');
  assert.deepEqual(
    { email: used.email, networkSlot: used.networkSlot, proxy: used.proxy },
    { email: 'recheck@example.com', networkSlot: 1, proxy: 'http://proxy-slot-1.invalid/' }
  );
  assert.notEqual(used.imp, 'client-fingerprint');
}));

test('locked resources cannot be deleted or cleared through resource routes', async () => withServer(async (base, root) => {
  const store = createResourceStore(root);
  const account = store.add('accounts', { accessToken: 'eyJhbGci.locked.account', user: { email: 'locked@example.com' } });
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Locked Card' });
  const address = store.add('addresses', { line1: '1 Lock St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' });
  for (const [kind, id] of [['accounts', account.id], ['cards', card.id], ['addresses', address.id]]) {
    assert.equal(store.reserve(kind, id, 'processing-task'), true);
    const deleted = await fetch(`${base}/api/resources/${kind}/${id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 409);
    const cleared = await fetch(`${base}/api/resources/${kind}/clear`, { method: 'POST' });
    assert.equal(cleared.status, 409);
    assert.ok(store.get(kind, id));
  }
}));

test('startup recovery fails only preconfirm tasks and keeps confirmation/checkout tasks locked as unknown', async () => {
  const ids = {};
  await withServer(async (_base, root) => {
    const tasks = createPaymentTaskStore(root);
    const resources = createResourceStore(root);
    assert.equal(tasks.getInternal(ids.interruptedTask).state, 'failed');
    assert.equal(tasks.getInternal(ids.interruptedTask).errorCode, 'interrupted');
    assert.equal(resources.list('accounts').find(item => item.id === ids.interruptedAccount).usage, undefined);
    assert.equal(tasks.getInternal(ids.unknownTask).state, 'unknown');
    assert.equal(resources.list('accounts').find(item => item.id === ids.unknownAccount).usage?.state, 'in_use');
    assert.equal(tasks.getInternal(ids.confirmTask).state, 'unknown');
    assert.equal(resources.list('accounts').find(item => item.id === ids.confirmAccount).usage?.state, 'in_use');
    assert.equal(tasks.getInternal(ids.checkoutTask).state, 'unknown');
    assert.equal(resources.list('accounts').find(item => item.id === ids.checkoutAccount).usage?.state, 'in_use');
  }, {
    setup(root) {
      const resources = createResourceStore(root);
      ids.interruptedAccount = resources.add('accounts', { accessToken: 'eyJhbGci.interrupted', user: { email: 'interrupted@example.com' } }).id;
      ids.unknownAccount = resources.add('accounts', { accessToken: 'eyJhbGci.unknown', user: { email: 'unknown@example.com' } }).id;
      ids.checkoutAccount = resources.add('accounts', { accessToken: 'eyJhbGci.checkout', user: { email: 'checkout@example.com' } }).id;
      ids.confirmAccount = resources.add('accounts', { accessToken: 'eyJhbGci.confirm', user: { email: 'confirm@example.com' } }).id;
      const tasks = createPaymentTaskStore(root);
      ids.interruptedTask = tasks.create({ idempotencyKey: 'interrupted-startup', state: 'processing', accountResourceId: ids.interruptedAccount }).id;
      ids.unknownTask = tasks.create({ idempotencyKey: 'unknown-startup', state: 'unknown', accountResourceId: ids.unknownAccount }).id;
      ids.checkoutTask = tasks.create({ idempotencyKey: 'checkout-startup', state: 'processing', accountResourceId: ids.checkoutAccount }).id;
      ids.confirmTask = tasks.create({ idempotencyKey: 'confirm-startup', state: 'processing', stage: 'confirm_started', accountResourceId: ids.confirmAccount }).id;
      tasks.update(ids.checkoutTask, { checkoutSessionId: 'cs_existing' });
      resources.reserve('accounts', ids.interruptedAccount, ids.interruptedTask);
      resources.reserve('accounts', ids.unknownAccount, ids.unknownTask);
      resources.reserve('accounts', ids.checkoutAccount, ids.checkoutTask);
      resources.reserve('accounts', ids.confirmAccount, ids.confirmTask);
    }
  });
});

test('startup account checks skip completed accounts and never exceed three workers', async () => {
  await withServer(async (_base, _root, audit) => {
    const events = await waitFor(
      audit,
      rows => rows.filter(row => row.type === 'account-check-end').length === 6,
      'startup account checks did not finish'
    );
    const starts = events.filter(row => row.type === 'account-check-start');
    assert.equal(starts.length, 6);
    assert.equal(starts.some(row => row.email === 'completed@example.com'), false);
    assert.ok(Math.max(...starts.map(row => row.active)) <= 3);
  }, {
    env: {
      DIPAY_DISABLE_ACCOUNT_STATUS_CHECK: '0',
      DIPAY_FAKE_ACCOUNT_STATUS_CHECK: '1',
      DIPAY_FAKE_ACCOUNT_STATUS_DELAY_MS: '25'
    },
    setup(root) {
      const store = createResourceStore(root);
      for (let index = 0; index < 6; index++) {
        store.add('accounts', { accessToken: `eyJhbGci.free${index}`, user: { email: `free${index}@example.com` } });
      }
      const completed = store.add('accounts', { accessToken: 'eyJhbGci.completed', user: { email: 'completed@example.com' } });
      store.completeAccount(completed.id, { taskId: 'completed-task', amount: 99900, currency: 'PHP', plan: 'chatgptplusplan' });
    }
  });
});

test('batch reservation conflicts are classified and bounded per account', async () => {
  for (const [kind, expectedMaximum] of [['accounts', 1], ['cards', 2], ['addresses', 2]]) {
    await withServer(async (base, _root, audit) => {
      const response = await fetch(`${base}/api/payment-tasks/batch`, {
        method: 'POST',
        body: JSON.stringify({ plan: 'chatgptpro', concurrency: 1 })
      });
      assert.equal(response.status, 202);
      const created = await response.json();
      const batch = await waitFor(
        async () => (await fetch(`${base}/api/payment-batches/${created.id}`)).json(),
        value => value.state !== 'processing',
        `${kind} conflict batch did not terminate`
      );
      assert.ok(batch.tasks.length <= expectedMaximum, `${kind} conflict created too many task files`);
      const conflict = batch.tasks.find(task => task.errorCode === 'resource_in_use');
      assert.ok(conflict, `${kind} conflict was not recorded`);
      assert.equal(conflict.email, `${kind}@example.com`);
      const conflictEvent = (await waitFor(audit, rows => rows.some(row => row.type === 'batch-reservation-conflict')))
        .find(row => row.type === 'batch-reservation-conflict');
      assert.equal(conflictEvent.failedKind, kind);
      if (kind === 'addresses') {
        const payment = (await waitFor(audit, rows => rows.some(row => row.type === 'payment-start')))
          .find(row => row.type === 'payment-start');
        assert.equal(payment.addressResourceId, '');
      }
    }, {
      env: { DIPAY_TEST_RESERVE_CONFLICT_KIND: kind },
      setup(root) {
        const store = createResourceStore(root);
        const account = store.add('accounts', { accessToken: `eyJhbGci.batch.${kind}`, user: { email: `${kind}@example.com` } });
        store.updateAccountStatus(account.id, { state: 'free', plan: 'chatgptfreeplan' });
        store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Batch Card' });
        store.add('addresses', { line1: '1 Batch St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' });
      }
    });
  }
});

test('batch tasks persist the worker network slot without exposing it publicly', async () => withServer(async (base, root) => {
  const response = await fetch(`${base}/api/payment-tasks/batch`, {
    method: 'POST',
    body: JSON.stringify({ plan: 'chatgptpro', concurrency: 2 })
  });
  assert.equal(response.status, 202);
  const created = await response.json();
  const batch = await waitFor(
    async () => (await fetch(`${base}/api/payment-batches/${created.id}`)).json(),
    value => value.state !== 'processing'
  );
  assert.equal(batch.tasks.length, 2);
  assert.equal(batch.tasks.some(task => Object.hasOwn(task, 'networkSlot')), false);
  const store = createPaymentTaskStore(root);
  assert.deepEqual(batch.tasks.map(task => store.getInternal(task.id).networkSlot).sort(), [0, 1]);
}, {
  setup(root) {
    const store = createResourceStore(root);
    for (let index = 0; index < 2; index++) {
      const account = store.add('accounts', {
        accessToken: `eyJhbGci.worker${index}`,
        user: { email: `worker${index}@example.com` }
      });
      store.updateAccountStatus(account.id, { state: 'free', plan: 'chatgptfreeplan' });
      store.add('cards', {
        number: index === 0 ? '4242424242424242' : '5555555555554444',
        exp: '12/30',
        cvc: '123',
        name: `Worker Card ${index}`
      });
    }
  }
}));

test('batch reuses one released card in order without dropping an account', async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/payment-tasks/batch`, {
    method: 'POST',
    body: JSON.stringify({ plan: 'chatgptpro', concurrency: 2 })
  });
  assert.equal(response.status, 202);
  const created = await response.json();
  const batch = await waitFor(
    async () => (await fetch(`${base}/api/payment-batches/${created.id}`)).json(),
    value => value.state !== 'processing'
  );
  assert.equal(batch.total, 2);
  assert.equal(batch.tasks.length, 2);
  assert.equal(batch.tasks.filter(task => task.errorCode === 'resource_unavailable').length, 0);
}, {
  setup(root) {
    const store = createResourceStore(root);
    for (let index = 0; index < 2; index++) {
      const account = store.add('accounts', {
        accessToken: `eyJhbGci.exhausted${index}`,
        user: { email: `exhausted${index}@example.com` }
      });
      store.updateAccountStatus(account.id, { state: 'free', plan: 'chatgptfreeplan' });
    }
    store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Only Card' });
  }
}));

test('batch accepts a cooling card and waits until it becomes reusable', async () => withServer(async base => {
  const response = await fetch(`${base}/api/payment-tasks/batch`, {
    method: 'POST',
    body: JSON.stringify({ plan: 'chatgptpro', concurrency: 1 })
  });
  assert.equal(response.status, 202);
  const created = await response.json();
  const batch = await waitFor(
    async () => (await fetch(`${base}/api/payment-batches/${created.id}`)).json(),
    value => value.state !== 'processing'
  );
  assert.equal(batch.tasks.length, 1);
  assert.equal(batch.tasks[0].errorCode, '');
}, {
  setup(root) {
    const store = createResourceStore(root);
    const account = store.add('accounts', {
      accessToken: 'eyJhbGci.cooldown',
      user: { email: 'cooldown@example.com' }
    });
    store.updateAccountStatus(account.id, { state: 'free', plan: 'chatgptfreeplan' });
    const card = store.add('cards', {
      number: '4242424242424242',
      exp: '12/30',
      cvc: '123',
      name: 'Cooling Card'
    });
    store.reserve('cards', card.id, 'previous-task');
    store.release('cards', card.id, 'previous-task', { cooldownMs: 2500 });
  }
}));

test('payment error UI maps reliability failures to safe messages', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  for (const code of ['cloudflare_challenge_failed', 'account_already_subscribed', 'account_status_check_failed', 'actual_amount_unavailable', 'promotional_offer_attached', 'payment_result_unknown']) {
    assert.match(source, new RegExp(`code === '${code}'`));
  }
  assert.doesNotMatch(source, /new Set\(\['succeeded', 'failed', 'unknown'\]\)/);
  assert.match(source, /task\.state === 'unknown' \|\| task\.state === 'pending_3ds' \|\| task\.state === 'completing_3ds'/);
  assert.equal((source.match(/\bpay\.onclick\s*=/g) || []).length, 1);
  assert.doesNotMatch(source, /function refreshAccounts\s*\(/);
  assert.doesNotMatch(source, /function wireResource\s*\(/);
  assert.doesNotMatch(source, /refreshAddresses\s*\(/);
  assert.doesNotMatch(source, /\/api\/accounts\/import/);
});

test('legacy batch-pay route is unconditionally retired', async () => withServer(async base => {
  for (const method of ['GET', 'POST']) {
    const response = await fetch(`${base}/api/batch-pay`, { method });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { error: 'use /api/payment-tasks/batch' });
  }
}));

test('link generation accepts credentials only in a POST body and retires query-string routes', async () => withServer(async (base, _root, audit) => {
  const legacy = await fetch(`${base}/api/link?payload=${encodeURIComponent(JSON.stringify({
    sessionJson: 'eyJhbGci.must.not.enter.url'
  }))}`);
  assert.equal(legacy.status, 405);

  const response = await fetch(`${base}/api/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionJson: JSON.stringify({
        accessToken: 'eyJhbGci.post.only',
        user: { email: 'post-link@example.com' }
      }),
      plan: 'chatgptplusplan'
    })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: 'disabled', links: {} });
  const events = await waitFor(audit, rows => rows.some(row => row.type === 'link-start'));
  assert.equal(events.find(row => row.type === 'link-start').email, 'post-link@example.com');
}));

test('payment tasks require POST idempotency and expose only redacted task views', async () => withServer(async (base, root) => {
  const legacy = await fetch(`${base}/api/pay?payload=${encodeURIComponent('{}')}`);
  assert.equal(legacy.status, 405);

  const missingKey = await fetch(`${base}/api/payment-tasks`, { method: 'POST', body: '{}' });
  assert.equal(missingKey.status, 400);

  const store = createPaymentTaskStore(root);
  const task = store.create({
    idempotencyKey: 'do-not-return', email: 'safe@example.com', cardLast4: '4242',
    checkoutSessionId: 'cs_do-not-return', state: 'pending_3ds', verificationUrl: 'https://verify.example/3ds'
  });
  const response = await fetch(`${base}/api/payment-tasks/${task.id}`);
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.state, 'pending_3ds');
  assert.equal(view.verificationUrl, 'https://verify.example/3ds');
  assert.doesNotMatch(JSON.stringify(view), /do-not-return|cs_do-not-return/);
}));

test('cancelling an unresolved 3DS task releases every held resource', async () => {
  let taskId = '';
  await withServer(async (base, root) => {
    const response = await fetch(`${base}/api/payment-tasks/${taskId}/cancel`, { method: 'POST' });
    assert.equal(response.status, 200);
    const task = await response.json();
    assert.equal(task.state, 'failed');
    assert.equal(task.errorCode, 'user_cancelled');

    const resources = createResourceStore(root);
    assert.equal(resources.list('accounts')[0].usage.state, 'available');
    assert.equal(resources.list('cards')[0].usage.state, 'available');
    assert.equal(resources.list('addresses')[0].usage.state, 'available');
  }, {
    setup(root) {
      const resources = createResourceStore(root);
      const accountId = resources.add('accounts', {
        accessToken: 'eyJhbGci.cancel.account',
        user: { email: 'cancel@example.com' }
      }).id;
      const cardId = resources.add('cards', {
        number: '4242424242424242', exp_month: '12', exp_year: '30', cvc: '123'
      }).id;
      const addressId = resources.add('addresses', {
        line1: '1 Main St', city: 'Seattle', state: 'WA', postal_code: '98101', country: 'US'
      }).id;
      const tasks = createPaymentTaskStore(root);
      taskId = tasks.create({
        idempotencyKey: 'cancel-held-3ds',
        state: 'pending_3ds',
        accountResourceId: accountId,
        cardResourceId: cardId,
        addressResourceId: addressId,
        threeDsDetectedAt: new Date().toISOString()
      }).id;
      resources.reserve('accounts', accountId, taskId);
      resources.reserve('cards', cardId, taskId);
      resources.reserve('addresses', addressId, taskId);
    }
  });
});

test('defaults endpoint never returns payment card data', async () => withServer(async base => {
  const defaults = await (await fetch(`${base}/api/defaults`)).json();
  assert.equal(Object.hasOwn(defaults, 'card'), false);
}));

test('account resources support individual deletion and clearing', async () => withServer(async base => {
  for (const [name, token, email] of [['one.json', 'eyJhbGci.one.signature', 'one@example.com'], ['two.json', 'eyJhbGci.two.signature', 'two@example.com']]) {
    await fetch(`${base}/api/resources/accounts/import`, {
      method: 'POST', body: JSON.stringify({ file: { name, text: JSON.stringify({ accessToken: token, user: { email } }) } })
    });
  }
  const accounts = await (await fetch(`${base}/api/accounts`)).json();
  const deleted = await (await fetch(`${base}/api/resources/accounts/${accounts[0].id}`, { method: 'DELETE' })).json();
  assert.deepEqual(deleted, { deleted: true });
  const cleared = await (await fetch(`${base}/api/resources/accounts/clear`, { method: 'POST' })).json();
  assert.deepEqual(cleared, { cleared: 1 });
  assert.equal((await (await fetch(`${base}/api/accounts`)).json()).length, 0);
}));

test('success history API returns only confirmed payments and clearing does not touch resources', async () => withServer(async (base, root) => {
  const resourceStore = createResourceStore(root);
  const account = resourceStore.add('accounts', { accessToken: 'eyJhbGci.paid.signature', user: { email: 'paid@example.com' } });
  const taskStore = createPaymentTaskStore(root);
  taskStore.create({
    idempotencyKey: 'confirmed-payment-history',
    state: 'succeeded',
    email: 'paid@example.com',
    cardLast4: '4242',
    amount: 110000,
    currency: 'PHP',
    plan: 'chatgptplusplan'
  });
  taskStore.create({ idempotencyKey: 'failed-payment-history', state: 'failed', email: 'failed@example.com' });

  const history = await (await fetch(`${base}/api/payment-tasks?state=succeeded&limit=100`)).json();
  assert.equal(history.length, 1);
  assert.equal(history[0].email, 'paid@example.com');
  assert.equal(history[0].plan, 'chatgptplusplan');

  const cleared = await (await fetch(`${base}/api/payment-tasks/succeeded`, { method: 'DELETE' })).json();
  assert.deepEqual(cleared, { cleared: 1 });
  assert.ok(resourceStore.get('accounts', account.id));
  assert.equal(taskStore.list().length, 1);
  assert.equal(taskStore.list()[0].state, 'failed');
}));
