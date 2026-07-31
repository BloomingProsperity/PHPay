# Validation Service UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crowded solver configuration block with a compact, accessible validation-service card while preserving the existing save and test behavior.

**Architecture:** Keep the existing API and DOM event flow. Change only the solver card markup, its scoped CSS, and static UI assertions so the default view is compact and advanced fields expand in place.

**Tech Stack:** HTML, CSS, vanilla JavaScript, Node.js static UI tests.

---

### Task 1: Compact validation-service card

**Files:**
- Modify: `public/index.html`
- Modify: `test/resource-ui.mjs`

- [ ] **Step 1: Write the failing UI assertions**

Add assertions that require:

```js
assert.match(source, /id="solver-title">验证服务/);
assert.match(source, /id="solver-status"/);
assert.match(source, /aria-controls="solver-settings"/);
assert.match(source, /id="solver-settings"[^>]*hidden/);
assert.match(source, /备用验证密钥/);
assert.match(source, /连接现有浏览器/);
assert.doesNotMatch(source, /BROWSER_WS_ENDPOINT/);
assert.doesNotMatch(source, /保存后写入 config\/solver\.json/);
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
node test/resource-ui.mjs
```

Expected: failure because the current card still uses the old title and technical copy.

- [ ] **Step 3: Implement the compact card**

In `public/index.html`:

- rename the card heading to `验证服务`;
- keep a single status row visible by default;
- give the configuration button `aria-controls="solver-settings"` and maintain `aria-expanded`;
- wrap both inputs and actions in `<div id="solver-settings" hidden>`;
- rename the labels to `备用验证密钥` and `连接现有浏览器`;
- remove the environment-variable and configuration-file explanations from visible copy;
- preserve the existing element IDs used by save/test JavaScript;
- add solver-scoped styles for a pale-blue expanded surface, compact status pill, focus state, responsive wrapping, and reduced-motion support;
- update the existing toggle handler so opening removes `hidden` and applies the short transition class, while closing restores `hidden` after the transition.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
node test/resource-ui.mjs
node test/status-panel-geometry.mjs
node --test test/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Browser smoke**

Rebuild Docker, open `http://127.0.0.1:3456/`, and verify:

- the default card is compact;
- keyboard activation opens and closes settings;
- saved keys remain masked;
- test/save messages stay inside the card;
- no payment endpoint is called.

This workspace is not a Git repository, so there is no commit step.
