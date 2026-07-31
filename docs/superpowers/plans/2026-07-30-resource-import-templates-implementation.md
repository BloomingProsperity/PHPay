# Resource Import Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe per-resource import templates and enforce atomic, locally validated card records.

**Architecture:** Keep templates client-side as generated text downloads. Keep the existing file-per-request importer; strengthen only card normalization so each parsed record is independently checked before storage.

**Tech Stack:** Node.js ESM, vanilla browser JavaScript, `node:test`, Playwright Core, Docker Compose.

---

### Task 1: Write failing card-validation tests

**Files:**
- Modify: `C:\Users\h\Desktop\dipay\test\resource-importers.test.mjs`

- [ ] Add tests that accept a formatted Luhn-valid card and reject a Luhn-invalid number and letters:

```js
test('cards accept formatted Luhn-valid numbers but reject invalid or non-card text', () => {
  const valid = parseResourceFile('cards', { name: 'cards.txt', text: '4242-4242 4242-4242|12/30|123|Jane' });
  assert.equal(valid.records.length, 1);
  assert.equal(valid.records[0].number, '4242424242424242');
  const invalid = parseResourceFile('cards', { name: 'cards.txt', text: '4242424242424241|12/30|123\ncard-4242|12/30|123' });
  assert.deepEqual(invalid.errors.map(error => error.reason), ['invalid card number', 'invalid card number']);
});
```

- [ ] Run `node --test test/resource-importers.test.mjs` and confirm the Luhn-invalid record currently fails the new expectation.

### Task 2: Implement strict card number normalization

**Files:**
- Modify: `C:\Users\h\Desktop\dipay\src\resource-importers.js`
- Test: `C:\Users\h\Desktop\dipay\test\resource-importers.test.mjs`

- [ ] Add `isLuhnValid(number)` and require a raw card string matching `^[0-9 -]+$` before digits are normalized.
- [ ] Keep `normalizeCard` record-local: validate its own number, expiration and CVC only; it must not inspect another record.
- [ ] Run `node --test test/resource-importers.test.mjs` and `npm run test:resources`.

### Task 3: Test and add per-resource template downloads

**Files:**
- Modify: `C:\Users\h\Desktop\dipay\test\resource-ui.mjs`
- Modify: `C:\Users\h\Desktop\dipay\public\index.html`

- [ ] Add browser checks that each import drawer exposes one `data-resource-template` control with its resource kind.
- [ ] Add template metadata in the resource configuration:

```js
template: { filename: 'cards.csv', type: 'text/csv;charset=utf-8', text: 'number,exp,cvc,name\n' }
```

- [ ] Render a `下载模板` button before `+ 选择文件`; on click create a Blob, click a temporary download link, and revoke the object URL.
- [ ] Run `npm run test:resource-ui -- http://127.0.0.1:3456` after rebuilding Docker.

### Task 4: Verify and deploy

**Files:**
- Modify: none

- [ ] Run `node --check src/resource-importers.js && npm run test:resources && node --test test/resource-api.test.mjs`.
- [ ] Run `docker compose up -d --build`, verify `/api/health`, and run `npm run test:resource-ui -- http://127.0.0.1:3456`.
- [ ] The workspace is not a Git repository; do not create a repository or commit.
