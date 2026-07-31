# Strict Resource Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three ad-hoc file-folder import flows with strict per-file imports, redacted resource lists, visible single-task selections, and B-style import drawers while preserving manual card/address entry.

**Architecture:** Keep the local JSON folders as the persistence boundary. Add focused importer and resource-store modules, then make `src/server.js` a thin HTTP adapter. The browser imports one selected file at a time so it can show truthful file-level progress; list APIs return views only, while an explicit one-resource “use” request powers the existing single-task form without changing payment or external-validation routines.

**Tech Stack:** Node.js ESM, built-in `node:test`, built-in `node:crypto`, local JSON files, vanilla HTML/CSS/JavaScript, Docker Compose.

**Repository note:** This workspace has no Git repository; omit commit steps and report verification evidence instead.

---

### Task 1: Establish resource-import regression tests

**Files:**
- Create: `test/resource-importers.test.mjs`
- Create: `test/resource-store.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write importer tests before creating the importer module**

```js
// test/resource-importers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResourceFile } from '../src/resource-importers.js';

test('cards parse only the documented pipe TXT grammar', () => {
  const result = parseResourceFile('cards', {
    name: 'cards.txt', text: '4242424242424242|12/30|123|Jane Doe\ninvalid'
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.records[0], {
    number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Jane Doe'
  });
});

test('addresses reject four-column delimited input instead of treating a zip as country', () => {
  const result = parseResourceFile('addresses', {
    name: 'addresses.txt', text: '123 Main St|Seattle|WA|98101'
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].reason, /five fields/i);
});

test('address CSV requires a mapped header and preserves file-local rows', () => {
  const result = parseResourceFile('addresses', {
    name: 'addresses.csv',
    text: 'street,city,state,zip,country\n1 Main St,Seattle,WA,98101,US'
  });
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0], {
    line1: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US'
  });
});

test('a JSON account file must contain a supported token field', () => {
  const result = parseResourceFile('accounts', {
    name: 'accounts.json', text: JSON.stringify([{ user: { email: 'a@example.com' } }])
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.errors.length, 1);
});
```

- [ ] **Step 2: Run the test and verify it fails because the module does not exist**

Run: `node --test test/resource-importers.test.mjs`

Expected: failure naming `src/resource-importers.js`.

- [ ] **Step 3: Write resource-store tests using a temporary directory**

```js
// test/resource-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResourceStore } from '../src/resource-store.js';

test('store skips a duplicate without overwriting the original resource', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-store-'));
  try {
    const store = createResourceStore(root);
    const card = { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Jane Doe' };
    assert.equal(store.add('cards', card, { file: 'one.txt', line: 1 }).status, 'added');
    assert.equal(store.add('cards', { ...card, name: 'Changed' }, { file: 'two.txt', line: 1 }).status, 'duplicate');
    const [view] = store.list('cards');
    assert.equal(view.masked, '•••• 4242');
    assert.equal(Object.hasOwn(view, 'number'), false);
    assert.equal(Object.hasOwn(view, 'cvc'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 4: Add one non-destructive test command**

```json
"scripts": {
  "dev": "node src/server.js",
  "start": "node src/server.js",
  "test:resources": "node --test test/resource-importers.test.mjs test/resource-store.test.mjs"
}
```

- [ ] **Step 5: Run the whole resource test command and record the expected red state**

Run: `npm run test:resources`

Expected: the importer and store module-not-found failures; no workspace resource folders are changed.

### Task 2: Implement strict, file-local importers

**Files:**
- Create: `src/resource-importers.js`
- Modify: `test/resource-importers.test.mjs`

- [ ] **Step 1: Implement the module’s public contract**

```js
export function parseResourceFile(kind, file) {
  const extension = extensionOf(file.name);
  const parser = PARSERS[kind]?.[extension];
  if (!parser) return failure(`unsupported file type: ${extension || 'none'}`);
  try {
    const rows = parser(String(file.text || ''));
    return validateRows(kind, rows);
  } catch (error) {
    return failure(error.message || 'invalid file');
  }
}

function failure(reason) {
  return { records: [], errors: [{ line: null, reason }] };
}
```

- [ ] **Step 2: Implement explicit parsers only**

Implement `PARSERS` with these exact boundaries:

```js
const PARSERS = {
  accounts: { json: parseAccountJson, txt: parseOneAccountText },
  cards: { json: parseCardJson, csv: parseCardCsv, txt: parseCardPipeText },
  addresses: { json: parseAddressJson, csv: parseAddressCsv, txt: parseAddressPipeText }
};
```

`parseCardPipeText` accepts only `number|MM/YY|CVC|name` with the final name optional. `parseAddressPipeText` accepts exactly five pipe-separated fields. CSV parsing must process quoted cells and map only the aliases listed in the approved design. JSON may be one object or one array; it must reject trailing content and unrecognized required shapes.

- [ ] **Step 3: Normalize and validate every record**

Use canonical record shapes and explicit validators:

```js
const CARD_MONTH = /^(0[1-9]|1[0-2])$/;
const CARD_YEAR = /^\d{2}(\d{2})?$/;

function normalizeCard(raw) {
  const number = String(raw.number || '').replace(/\D/g, '');
  const [month = '', year = ''] = String(raw.exp || '').trim().split('/');
  if (!/^\d{13,19}$/.test(number)) throw new Error('invalid card number');
  if (!CARD_MONTH.test(month) || !CARD_YEAR.test(year)) throw new Error('invalid expiration');
  if (!/^\d{3,4}$/.test(String(raw.cvc || ''))) throw new Error('invalid security code');
  return { number, exp: `${month}/${year}`, cvc: String(raw.cvc), name: String(raw.name || '').trim() };
}
```

Reject past calendar months, missing address fields, non-two-letter US state when `country === 'US'`, and account objects without a supported token field. Return `{ records, errors }` with a line number for text/CSV records; never include raw record content in errors.

- [ ] **Step 4: Expand tests for JSON arrays, CSV aliases, past expiry, and unsupported extension**

Add table-driven assertions that each error is a reason/line pair and never has a `raw` property.

- [ ] **Step 5: Run importer tests**

Run: `node --test test/resource-importers.test.mjs`

Expected: PASS.

### Task 3: Add an idempotent, redacted local resource store

**Files:**
- Create: `src/resource-store.js`
- Modify: `test/resource-store.test.mjs`

- [ ] **Step 1: Implement a store factory rooted at an injected directory**

```js
export function createResourceStore(root) {
  return { add, list, get };
  function add(kind, record, source) { /* task implementation */ }
  function list(kind) { /* redacted views only */ }
  function get(kind, id) { /* full record only for an explicit use request */ }
}
```

Build a stable `id` with `sha256(kind + '\0' + canonicalDedupKey(record))`, retain `{ id, data, meta }` in the file, and write through a same-directory temporary file followed by `renameSync`.

- [ ] **Step 2: Define duplicate keys and redacted views**

```js
function canonicalDedupKey(kind, data) {
  if (kind === 'accounts') return String(data.accessToken || data.sessionToken);
  if (kind === 'cards') return `${data.number}|${data.exp}|${data.cvc}`;
  return [data.line1, data.city, data.state, data.zip, data.country]
    .map(value => String(value).trim().toLowerCase()).join('|');
}
```

`list('accounts')` returns `{ id, label, importedAt }`; `list('cards')` returns `{ id, masked, name, importedAt }`; `list('addresses')` returns `{ id, label, importedAt }`. It must never return token fields, full card number, or `cvc`.

- [ ] **Step 3: Preserve legacy directory readability**

When listing, recognize existing plain resource JSON files and treat them as legacy records. On new writes, retain the existing `accounts/`, `cards/`, `addresses/` folders and type-compatible filenames so unchanged batch code can still read them. Add `_resource` metadata without changing the stored data fields required by existing readers.

- [ ] **Step 4: Add store tests for card redaction, address labels, stable IDs, duplicate skip, and legacy-file listing**

Run: `node --test test/resource-store.test.mjs`

Expected: PASS.

### Task 4: Replace import/list HTTP handlers with the resource layer

**Files:**
- Modify: `src/server.js`
- Create: `test/resource-api.test.mjs`

- [ ] **Step 1: Write API tests against an isolated spawned server**

Start `src/server.js` on a random free port with `DIPAY_STORAGE_ROOT` set to a `mkdtempSync` directory; create only that directory's `accounts`, `cards`, and `addresses` children. Test `POST /api/resources/cards/import` with one `{ file: { name, text } }` body, then `GET /api/cards`. Assert the import response contains:

```js
{ file: 'cards.txt', added: 1, duplicate: 0, errors: [] }
```

Assert an invalid file returns `{ added: 0, duplicate: 0, errors: [{ line: 1, reason: '…' }] }` with status 200 and that the list does not expose `number` or `cvc`.

- [ ] **Step 2: Extract one bounded JSON-body reader in `src/server.js`**

```js
async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  let size = 0; let body = '';
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    body += chunk;
  }
  return JSON.parse(body || '{}');
}
```

Use it for new resource imports; return a clear 400 JSON error for malformed bodies. Do not alter SSE or payment route handling.

Resolve resource folders from an explicit isolated-root override before using the existing workspace paths:

```js
const STORAGE_ROOT = process.env.DIPAY_STORAGE_ROOT
  ? path.resolve(process.env.DIPAY_STORAGE_ROOT)
  : path.join(ROOT, '..');
const ACCOUNTS_DIR = path.join(STORAGE_ROOT, 'accounts');
const CARDS_DIR = path.join(STORAGE_ROOT, 'cards');
const ADDR_DIR = path.join(STORAGE_ROOT, 'addresses');
const OUT_DIR = path.join(STORAGE_ROOT, 'out');
```

- [ ] **Step 3: Add resource endpoints and make legacy list endpoints safe**

Add `POST /api/resources/:kind/import` and route it to `parseResourceFile` and `createResourceStore`. Keep `GET /api/accounts`, `GET /api/cards`, and `GET /api/addresses`, but route them through `store.list(kind)` so they return only redacted views. Preserve existing clear endpoints, but make their UI callers ask for confirmation before calling them.

- [ ] **Step 4: Add an explicit one-resource use endpoint**

Add `POST /api/resources/:kind/use` accepting `{ id }`. It loads only that record through `store.get(kind, id)` and returns only the fields required by the existing single-task form. Reject missing IDs with 404. This keeps list endpoints redacted and does not modify `runPay`, `runLink`, batch routes, or external validation.

- [ ] **Step 5: Run the isolated API tests**

Run: `node --test test/resource-api.test.mjs`

Expected: PASS; the test server uses temporary folders and never invokes an external route.

### Task 5: Replace duplicated resource controls with B-style drawers

**Files:**
- Modify: `public/index.html`
- Modify: `test/e2e.mjs`

- [ ] **Step 1: Write failing browser assertions for the new resource contract**

Replace assertions for the old `#files`, `#bulk`, and `#import` controls with assertions that each resource row has one `导入文件` button, opening a drawer containing exactly one file chooser and one `开始导入` button. Assert the chooser accepts `.json,.txt` for accounts and `.json,.csv,.txt` for cards/addresses.

- [ ] **Step 2: Replace the three inline import bodies with one reusable drawer**

Create one modal/drawer state object:

```js
const importDrawer = { kind: null, files: [], running: false };

function openImportDrawer(kind) { /* render title, accepted formats, selected file chips */ }
function removeImportFile(index) { /* remove exactly one queued file */ }
async function startImport() { /* POST each queued file independently and render result */ }
```

Render per-file states `等待导入`, `解析中`, `新增 N / 重复 N / 错误 N`, and retain failed files for retry. Remove the old textareas, file inputs, `wireImport`, and duplicated import buttons.

Keep an explicit address-generation control separate from file import. It remains user-triggered, uses the existing generation endpoint, visibly states that generated addresses are saved to the address library, and never runs as a hidden consequence of opening a drawer or selecting a resource.

- [ ] **Step 3: Make library selection visible and deliberate**

When `查看/选择` is clicked, render the redacted list. Selecting an item calls `POST /api/resources/:kind/use`, stores the returned data only in the current page state, updates the existing single-task inputs, and sets a visible chip in the task card:

```html
<div class="task-resource-summary" aria-live="polite">
  <span id="selected-account">账号：未选择</span>
  <span id="selected-card">卡：手动输入</span>
  <span id="selected-address">地址：手动输入</span>
</div>
```

Keep card/address manual controls inside the existing collapsible fallback section. On manual field edits, change the corresponding chip to `手动输入`.

- [ ] **Step 4: Correct user-visible batch wording without changing behavior**

Keep batch buttons and endpoints intact. Add a concise static hint beside batch controls that batch actions use their existing library-wide behavior and do not consume the single-task selection.

- [ ] **Step 5: Update non-destructive browser tests and run syntax checks**

Run: `node --check src/server.js; node --check test/e2e.mjs`

Expected: JavaScript files pass; the inline HTML JavaScript is exercised by the focused browser test below.

### Task 6: Add focused, safe UI verification and documentation

**Files:**
- Create: `test/resource-ui.mjs`
- Modify: `README.md`

- [ ] **Step 1: Implement a focused UI test that uses only an isolated local server**

`test/resource-ui.mjs` starts a temporary server/data root, opens the resource drawer, queues two in-memory files, starts import, verifies file-level counts, refreshes the redacted list, and selects one resource. It must not click payment, link, batch-link, or batch-payment buttons.

- [ ] **Step 2: Document the exact accepted file shapes**

Replace the README’s broad “automatic recognition” claims with the supported extensions, canonical TXT lines, CSV header requirement, duplicate-skip rule, and statement that import errors show file/line/category without raw sensitive values.

- [ ] **Step 3: Run all safe verification commands**

Run:

```powershell
npm run test:resources
node --test test/resource-api.test.mjs
node test/resource-ui.mjs
docker compose up -d --build
Invoke-RestMethod http://127.0.0.1:3456/api/health
```

Expected: all resource tests start their own temporary storage root and avoid external action controls; Docker health returns `ok: true`.

- [ ] **Step 4: Perform the completion audit**

Confirm each item from `docs/superpowers/specs/2026-07-30-resource-layer-design.md` against source, tests, and the rendered local page. Do not claim completion until strict imports, redacted lists, B drawers, visible selections, manual fallback, and non-payment scope all have direct evidence.

### Task 7: Add temporary-address preparation without implicit persistence

**Files:**
- Modify: `src/server.js`
- Modify: `public/index.html`
- Modify: `test/resource-api.test.mjs`
- Modify: `test/resource-ui.mjs`

- [ ] **Step 1: Write failing isolated API tests for temporary-address generation and explicit save**

Use a temporary storage root. Assert `POST /api/addresses/temporary` returns one valid generated address with `{ temporary: true }` and leaves `GET /api/addresses` unchanged. Then assert `POST /api/resources/addresses/import` with the returned address in a JSON file adds exactly one persisted address.

- [ ] **Step 2: Add a non-persisting temporary-address endpoint**

Add `POST /api/addresses/temporary`, call the existing `generateAddress` function once, and return only its normalized address fields plus `temporary: true`. It must not call `mkdirSync`, `writeFileSync`, or the resource store. Keep the existing explicit `/api/addresses/generate` endpoint as the only bulk persistence path.

- [ ] **Step 3: Prepare an address immediately before a single-task action**

In the browser, add `ensureTaskAddress()` before the existing single-task action starts. It returns immediately for a visible selected resource or nonempty manual address. Otherwise it calls `/api/addresses/temporary`, fills the existing fallback inputs, updates the visible chip to `本次临时地址`, and opens the fallback details so the user can inspect it. It does not modify batch actions.

- [ ] **Step 4: Add an explicit save control and tests**

Place `保存到地址库` next to the temporary-address marker in the fallback details. The button is enabled only while the current address is temporary; it submits that one address as `temporary-address.json` to the strict address import route, then refreshes the list and changes the marker to the saved resource label. Verify that generation alone does not alter the count and explicit save increments it once.

- [ ] **Step 5: Run the isolated API and UI tests**

Run:

```powershell
node --test test/resource-api.test.mjs
node test/resource-ui.mjs
```

Expected: temporary generation has no disk side effect, explicit save is the sole persistence event, and no test triggers any payment, link, batch-link, or batch-payment control.
