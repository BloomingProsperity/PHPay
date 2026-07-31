import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/reference-ui.css', import.meta.url), 'utf8');

test('reference stylesheet is the only page theme', () => {
  assert.match(html, /<link rel="stylesheet" href="\/reference-ui\.css">/);
  assert.doesNotMatch(
    html,
    /<style>[\s\S]*?<\/style>/,
    'legacy inline theme must not override the reference stylesheet',
  );
});

test('service cards use the supplied flex-wrap geometry', () => {
  assert.match(
    css,
    /\.services-grid\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*14px;[^}]*align-items:\s*stretch;/s,
  );
  assert.match(
    css,
    /\.service-card\s*\{[^}]*flex:\s*1 1 260px;/s,
  );
  assert.doesNotMatch(
    css,
    /\.three-ds-panel\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s,
    '3DS must not be forced onto a separate row',
  );
});

test('reference shell and primary panel geometry remain exact', () => {
  assert.match(css, /\.wrap\s*\{[^}]*max-width:\s*1360px;[^}]*padding:\s*30px 28px 72px;/s);
  assert.match(css, /\.reference-layout\s*\{[^}]*gap:\s*20px;/s);
  assert.match(css, /\.panel\s*\{[^}]*padding:\s*22px 24px;[^}]*border-radius:\s*18px;/s);
  assert.match(css, /\.payment-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.1fr\)\s*minmax\(340px,\s*1fr\);[^}]*gap:\s*26px;/s);
  assert.match(css, /\.status-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.5fr\)\s*minmax\(320px,\s*1fr\);[^}]*gap:\s*14px;/s);
});

test('single-task resource choices use the supplied stacked rows', () => {
  assert.match(html, /className = 'resource-choice-row'/);
  assert.match(html, /dataset\.resourceKind/);
  assert.match(css, /\.task-resource-summary\s*\{[^}]*display:\s*block;/s);
  assert.match(css, /\.resource-choice-row\s*\{[^}]*display:\s*flex;[^}]*padding:\s*11px 0;/s);
});

test('reference resource cards keep two visible actions', () => {
  assert.doesNotMatch(html, /querySelector\('\.resource-actions'\)\.append\(clear\)/);
  assert.match(html, /className = 'modal-library-tools'/);
});

test('3DS explanatory copy stays directly below its heading', () => {
  assert.match(
    css,
    /\.three-ds-panel\s*>\s*p\s*\{[^}]*margin:\s*10px 0 12px;[^}]*padding:\s*0;/s,
  );
  assert.match(css, /\.three-ds-groups\s*\{[^}]*margin-top:\s*0;/s);
});

test('solver clear controls are vertically centered inside their inputs', () => {
  assert.match(
    css,
    /\.field-clear\s*\{[^}]*top:\s*50%;[^}]*transform:\s*translateY\(-50%\);/s,
  );
});

test('3DS card renders counts and keeps account rows inside the modal', () => {
  assert.match(html, /点击数量查看账号列表与验证信息；系统按账号等级变化确认完成。/);
  assert.doesNotMatch(html, /<span class="pending-label">待处理<\/span>/);
  assert.match(html, /<div[^>]*id="three-ds-pending"[^>]*class="three-ds-summary"/);
  assert.match(html, /<strong id="three-ds-pending-count">0<\/strong>/);
  assert.match(html, /<button[^>]*id="three-ds-pending-view"[^>]*class="btn-sm three-ds-view"[^>]*>查看账号<\/button>/);
  assert.match(html, /<div[^>]*id="three-ds-completed"[^>]*class="three-ds-summary"/);
  assert.match(html, /<strong id="three-ds-completed-count">0<\/strong>/);
  assert.match(html, /<button[^>]*id="three-ds-completed-view"[^>]*class="btn-sm three-ds-view"[^>]*>查看账号<\/button>/);
  assert.match(html, /const renderSummary = \(button, count, tasks, label, completed\)/);
  assert.match(html, /empty\.textContent = completed \? '暂无完成记录' : '暂无待验证账号';/);
  assert.doesNotMatch(html, /button\.disabled = tasks\.length === 0/);
  assert.doesNotMatch(
    html,
    /for \(const task of tasks\.slice\(0, 4\)\) box\.append\(taskRow\(task, completed\)\)/,
    'the main 3DS card must not render account rows directly',
  );
});
