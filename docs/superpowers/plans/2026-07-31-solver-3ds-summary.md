# Solver and 3DS Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the solver clear-button alignment and replace inline 3DS account rows with clickable count summaries.

**Architecture:** Keep the existing task APIs and detail modal. Change only the CSS positioning and the `wireThreeDsPanel` presentation layer so the card renders one count button per state and opens the existing account-list modal on demand.

**Tech Stack:** HTML, CSS, browser JavaScript, Node.js test runner

---

### Task 1: Add focused regression assertions

**Files:**
- Modify: `test/reference-ui-layout.test.mjs`

- [ ] Add assertions requiring `translateY(-50%)` on `.field-clear`.
- [ ] Add assertions requiring two 3DS count controls and forbidding direct task-row rendering inside the main card.
- [ ] Run `node --test test/reference-ui-layout.test.mjs` and confirm the new assertions fail for the missing behavior.

### Task 2: Implement the presentation fix

**Files:**
- Modify: `public/reference-ui.css`
- Modify: `public/index.html`

- [ ] Center `.field-clear` with a vertical transform and a stable circular hit area.
- [ ] Replace the two inline 3DS lists with count buttons.
- [ ] Update `wireThreeDsPanel` so refresh updates counts and count-button clicks open the existing list modal.
- [ ] Preserve the existing account-detail modal and backend requests.

### Task 3: Verify only the affected UI

**Files:**
- Test: `test/reference-ui-layout.test.mjs`

- [ ] Run the focused test and confirm all assertions pass.
- [ ] Rebuild the Docker service.
- [ ] Inspect the right-side page, click both 3DS summary controls where possible, and check browser errors.

