# Reference UI 1:1 Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live UI geometrically match `C:\Users\h\Downloads\dipay 排版优化.dc.html` while preserving every existing workflow.

**Architecture:** Treat the supplied HTML as the sole visual source of truth. Remove the legacy inline theme so it cannot override the reference stylesheet, mirror the reference layout primitives directly, and attach the existing IDs/event handlers to those primitives without altering backend behavior.

**Tech Stack:** HTML, CSS, browser DOM geometry checks, existing vanilla JavaScript.

---

### Task 1: Lock the reference geometry with a failing test

**Files:**
- Create: `test/reference-ui-layout.test.mjs`

- [ ] Assert that the live document has no legacy inline theme, service cards share one row at a 1008px viewport, payment and status columns match the reference ratios, and all panels use the reference spacing/radius values.
- [ ] Run `node --test test/reference-ui-layout.test.mjs`; expect failure because the legacy `@media (max-width:1100px)` rule makes the 3DS card span both columns.

### Task 2: Remove legacy style contamination

**Files:**
- Modify: `public/index.html`

- [ ] Remove the old inline `<style>` block in full.
- [ ] Keep the `/reference-ui.css` link and all functional script code.
- [ ] Re-run the focused layout test; expect the legacy-style assertions to pass.

### Task 3: Mirror every reference layout primitive

**Files:**
- Modify: `public/reference-ui.css`
- Modify: `public/index.html`

- [ ] Change the services container to the reference `display:flex; flex-wrap:wrap; gap:14px; align-items:stretch`.
- [ ] Give every service card the reference `flex:1 1 260px`, padding, border, radius, and field background.
- [ ] Rebuild the selected account/card/address summary as three stacked reference rows while keeping the existing selection state and resource-library handlers.
- [ ] Match header, resource cards, payment columns, action buttons, status columns, and modal geometry to the reference values.
- [ ] Keep additional clear/delete controls inside functional dialogs when the reference top-level card has no visual slot for them.

### Task 4: Verify all widths and interactions

**Files:**
- Test: `test/reference-ui-layout.test.mjs`
- Test: `public/index.html`

- [ ] Run the focused geometry test at 1360px, 1008px, 760px, and 360px.
- [ ] Rebuild only the Docker service.
- [ ] Inspect the live page in the right-side browser at the current viewport.
- [ ] Open and close resource, import, proxy, and 3DS-related dialogs without invoking payment.
- [ ] Confirm the browser console has no errors and `/api/health` remains healthy.

