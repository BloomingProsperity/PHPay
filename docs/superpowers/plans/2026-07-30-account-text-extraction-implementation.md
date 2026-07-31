# Account TXT Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import account credentials from mixed TXT content while keeping import validation local, strict, deduplicated, and redacted.

**Architecture:** Extend the account TXT parser to emit normalized candidate records from JSON segments, named key/value fields, Authorization headers, Cookie assignments, and standalone token patterns. Keep source locations with each candidate, validate before storage, and return only count- and reason-level feedback to the import drawer.

**Tech Stack:** Node.js ESM, built-in `node:test`, browser-side vanilla JavaScript, Docker Compose.

---

### Task 1: Specify mixed-text extraction with failing parser tests

**Files:**
- Modify: `C:\Users\h\Desktop\dipay\test\resource-importers.test.mjs`

- [ ] **Step 1: Add a mixed TXT fixture and expected redacted outcomes**

```js
test('accounts extract JSON, bearer, cookie and named token fields from mixed TXT', () => {
  const text = [
    'note before credentials',
    '{"accessToken":"eyJ.valid.access","user":{"email":"json@example.com"}}',
    'Authorization: Bearer eyJ.header.access',
    '__Secure-next-auth.session-token=eyJ.cookie.session',
    'accessToken = eyJ.named.access',
    'not-a-credential'
  ].join('\n');
  const result = parseResourceFile('accounts', { name: 'accounts.txt', text });
  assert.equal(result.records.length, 4);
  assert.deepEqual(result.lines, [2, 3, 4, 5]);
  assert.equal(result.records[0].user.email, 'json@example.com');
  assert.equal(result.errors.length, 0);
});

test('account TXT invalid fragments do not leak their source text', () => {
  const result = parseResourceFile('accounts', { name: 'accounts.txt', text: 'secret-token-value' });
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.errors, [{ line: 1, reason: 'no recognizable account credential' }]);
  assert.doesNotMatch(JSON.stringify(result), /secret-token-value/);
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `node --test test/resource-importers.test.mjs`

Expected: the mixed TXT test fails because the current parser accepts exactly one `eyJ`-prefixed line only.

### Task 2: Implement account candidate extraction and local validation

**Files:**
- Modify: `C:\Users\h\Desktop\dipay\src\resource-importers.js:45-71`
- Test: `C:\Users\h\Desktop\dipay\test\resource-importers.test.mjs`

- [ ] **Step 1: Replace the single-token account TXT parser with ordered extractors**

```js
function parseAccountText(text) {
  const candidates = [
    ...extractJsonCandidates(text),
    ...extractNamedTokenCandidates(text),
    ...extractBearerCandidates(text),
    ...extractCookieCandidates(text),
    ...extractStandaloneTokenCandidates(text)
  ];
  const seen = new Set();
  const rows = [];
  for (const candidate of candidates.sort((a, b) => a.line - b.line)) {
    const key = candidate.value.accessToken || candidate.value.sessionToken;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(candidate);
  }
  return rows.length ? rows : [{ line: 1, error: 'no recognizable account credential' }];
}
```

- [ ] **Step 2: Keep extraction helpers local and return only normalized objects**

```js
function accountValue(token, email = '') {
  return token.includes('.') && token.split('.').length - 1 === 4
    ? { sessionToken: token, user: { email } }
    : { accessToken: token, user: { email } };
}

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}
```

Each extractor must only return `{ line, value }`; it must never return raw source text in `error` fields or result objects.

- [ ] **Step 3: Tighten `normalizeAccount` without external requests**

```js
function normalizeAccount(raw) {
  const accessToken = String(raw.accessToken || '').trim();
  const sessionToken = String(raw.sessionToken || '').trim();
  const token = accessToken || sessionToken;
  if (!token || !isRecognizableAccountToken(token)) throw new Error('invalid account credential');
  const email = String(raw.user?.email || raw.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid account email');
  return accessToken ? { accessToken, user: { email } } : { sessionToken, user: { email } };
}
```

`isRecognizableAccountToken` performs only structural validation; it does not fetch, exchange, or otherwise validate the credential remotely.

- [ ] **Step 4: Run parser tests**

Run: `node --test test/resource-importers.test.mjs`

Expected: all parser tests pass, including mixed-text extraction and no sensitive-string leakage.

### Task 3: Preserve source metadata and safe import feedback

**Files:**
- Modify: `C:\Users\h\Desktop\dipay\src\server.js:113-145`
- Modify: `C:\Users\h\Desktop\dipay\public\index.html:540-552`
- Modify: `C:\Users\h\Desktop\dipay\test\resource-api.test.mjs`
- Modify: `C:\Users\h\Desktop\dipay\test\resource-ui.mjs`

- [ ] **Step 1: Add API coverage for the TXT import response**

```js
test('mixed account TXT imports valid records without exposing tokens', async () => withServer(async base => {
  const text = 'Authorization: Bearer eyJ.header.access\naccessToken=eyJ.named.access';
  const response = await fetch(`${base}/api/resources/accounts/import`, {
    method: 'POST', body: JSON.stringify({ file: { name: 'accounts.txt', text } })
  });
  const result = await response.json();
  assert.equal(result.added, 2);
  assert.doesNotMatch(JSON.stringify(result), /eyJ\./);
}));
```

- [ ] **Step 2: Render safe reason summaries beside each file**

```js
const reasons = result.errors.slice(0, 3).map(error =>
  `第${error.line ?? '？'}行：${error.reason}`
).join('；');
file._state = result.error
  ? `失败：${result.error}`
  : `新增 ${result.added} · 重复 ${result.duplicate} · 无效 ${result.errors.length}${reasons ? `（${reasons}）` : ''}`;
```

The UI must never render `file.text`, a candidate token, or a server value outside the redacted `errors` schema.

- [ ] **Step 3: Add a browser smoke assertion**

```js
assert.equal(await page.locator('#resource-file-picker').getAttribute('accept'), '.json,.txt');
assert.equal(await page.locator('#account-resource .resource-body').isVisible(), false);
```

- [ ] **Step 4: Run API and browser checks**

Run: `node --test test/resource-api.test.mjs && npm run test:resource-ui -- http://127.0.0.1:3456`

Expected: isolated imports pass and the live drawer still opens with the legacy form hidden.

### Task 4: Rebuild and verify the deployed app

**Files:**
- Modify: none

- [ ] **Step 1: Run static and unit checks**

Run: `node --check src/resource-importers.js && node --check src/server.js && npm run test:resources && node --test test/resource-api.test.mjs`

Expected: all commands exit with code 0.

- [ ] **Step 2: Rebuild Docker and run the UI smoke test**

Run: `docker compose up -d --build && npm run test:resource-ui -- http://127.0.0.1:3456`

Expected: health endpoint reports `ok: true` and the browser smoke test prints `PASS`.

- [ ] **Step 3: Commit**

The workspace is not a Git repository. Do not create a repository or commit; report the changed files and verification output instead.
