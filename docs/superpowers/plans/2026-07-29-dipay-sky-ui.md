# dipay 天空蓝白工作台 UI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变任何 API、支付参数或库数据行为的前提下，将 dipay 的单列黑色表单改为天空蓝白双栏工作台，并让资源导入和执行日志更清晰。

**Architecture:** 只修改 `public/index.html`：保留所有现有元素 id、事件处理函数和 `fetch`/`EventSource` 调用。通过新的页面分区、可展开资源行和少量前端展示状态，将原有的账号、卡、地址导入控件移动到右侧资源库；左侧只保留任务输入、套餐、执行操作和按需显示的支付资料。

**Tech Stack:** 原生 HTML、CSS、浏览器原生 JavaScript、Node.js HTTP 服务、Playwright Core E2E。

---

### Task 1: 写入并验证新的界面结构测试

**Files:**
- Modify: `C:/Users/h/Desktop/dipay/test/e2e.mjs`
- Test: `C:/Users/h/Desktop/dipay/test/e2e.mjs`

- [ ] **Step 1: 在页面加载断言后，写入工作台结构的失败断言**

  在 `check('标题', ...)` 后插入：

  ```js
  check('工作台主区域存在', await page.locator('.workspace').count() === 1);
  check('资源库含账号导入入口', await page.locator('#account-resource .resource-import').count() === 1);
  check('资源库含卡导入入口', await page.locator('#card-resource .resource-import').count() === 1);
  check('资源库含地址导入入口', await page.locator('#address-resource .resource-import').count() === 1);
  check('日志位于状态面板', await page.locator('.status-panel #log').count() === 1);
  ```

- [ ] **Step 2: 运行测试并确认新断言失败**

  Run: `node test/e2e.mjs http://127.0.0.1:3456`

  Expected: 在原页面上出现 `FAIL 工作台主区域存在`，其余旧行为的测试继续可运行。

- [ ] **Step 3: 在测试中验证导入面板可展开且原导入 id 仍可用**

  在账号导入测试开始前插入：

  ```js
  await page.click('#account-resource .resource-import');
  await page.waitForSelector('#account-resource .resource-body.is-open');
  check('账号导入面板可展开', true);
  check('账号批量输入仍可用', await page.locator('#bulk').count() === 1);
  ```

  在卡测试开始前插入相同模式的 `#card-resource .resource-import` 和 `#cardbulk` 断言；在地址测试开始前插入 `#address-resource .resource-import` 和 `#addrbulk` 断言。

- [ ] **Step 4: 运行测试并确认新增展开断言失败**

  Run: `node test/e2e.mjs http://127.0.0.1:3456`

  Expected: 失败原因是不存在 `#account-resource .resource-import`，而非原导入、选择或执行流程错误。

- [ ] **Step 5: 记录当前测试基线**

  本目录不是 Git 仓库，不能创建提交；保留命令输出，随后继续任务 2。

### Task 2: 重组页面为双栏工作台并保留原控件

**Files:**
- Modify: `C:/Users/h/Desktop/dipay/public/index.html`
- Test: `C:/Users/h/Desktop/dipay/test/e2e.mjs`

- [ ] **Step 1: 用语义容器包裹现有页面区域**

  在 `.wrap` 内创建以下稳定结构，保留并移动原有 id 对应的元素，不得复制同 id 元素：

  ```html
  <header class="app-header">...</header>
  <main class="workspace">
    <section class="task-column">
      <section class="summary-grid" aria-label="资源统计">...</section>
      <section class="task-card">...</section>
    </section>
    <aside class="side-column">
      <section class="resource-panel" aria-label="资源库">...</section>
      <section class="status-panel" aria-label="执行记录">...</section>
    </aside>
  </main>
  ```

  账号输入 `#sess`、套餐 `#plan`、并发 `#conc`、四个执行按钮以及 `#bar/#fill/#log/#links` 必须仍各有一个实例。将 `#log` 与 `#links` 移进 `.status-panel`。

- [ ] **Step 2: 为三个资源库区域建立统一可展开结构**

  使用下列模式承载现有控件；账号、卡和地址的资源 id 分别为 `account-resource`、`card-resource`、`address-resource`：

  ```html
  <section class="resource-item" id="account-resource">
    <div class="resource-row">
      <div class="resource-meta"><span class="resource-name">账号</span><strong id="account-count">0</strong></div>
      <div class="resource-actions">
        <button type="button" class="btn-outline resource-import" aria-expanded="false">导入</button>
        <button type="button" class="btn-outline resource-select">查看/选择</button>
      </div>
    </div>
    <div class="resource-body" hidden>原 #files、#import、#clear、#bulk、#acctstat、#acclist 控件</div>
  </section>
  ```

  `resource-select` 在账号、卡、地址行中分别触发现有 `#acclist button`、`#cardlist button`、`#addrlist button` 的点击行为。卡和地址行以相同方式承载各自的原控件。

- [ ] **Step 3: 使支付资料仅在需要时显示**

  把手工卡字段 `#num/#exp/#cvc/#name` 和手工地址字段 `#line1/#city/#state/#zip/#country` 放进 `#payment-details`，使用：

  ```html
  <details id="payment-details" class="payment-details">
    <summary>支付资料（仅立即支付需要）</summary>
    <!-- 原卡与地址手工字段，不移动资源库中的导入控件 -->
  </details>
  ```

  立即支付按钮的 click handler 在调用既有 `run('/api/pay?...')` 前不改变 payload 组装；仅当详情折叠且任一手工字段为空时执行 `document.getElementById('payment-details').open = true`，使缺失资料可见。

- [ ] **Step 4: 写入天空蓝白样式与淡橘主按钮**

  用以下设计令牌替换现有黑色 `:root` 变量，并为新分区添加样式：

  ```css
  :root {
    --page: #f6fbff;
    --surface: #ffffff;
    --surface-blue: #eef8ff;
    --line: #cfe5f6;
    --text: #18334f;
    --muted: #6f89a2;
    --sky: #68bff1;
    --sky-strong: #3da8e9;
    --accent: #f6bc78;
    --accent-hover: #efa95d;
    --danger: #d86b70;
    --radius: 16px;
  }
  .workspace { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(320px, 1fr); gap: 24px; }
  .summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .resource-body[hidden] { display: none; }
  .resource-body.is-open { display: grid; gap: 12px; }
  #pay, #link, #batch { background: var(--accent); border-color: var(--accent); color: #563812; }
  #pay:hover:not(:disabled), #link:hover:not(:disabled), #batch:hover:not(:disabled) { background: var(--accent-hover); }
  @media (max-width: 900px) { .workspace { grid-template-columns: 1fr; } .side-column { order: 2; } }
  ```

  所有 textarea、输入框和选择框必须使用白色表面、淡蓝边框、清晰焦点环；批量支付继续使用浅红描边而不是淡橘色。

- [ ] **Step 5: 添加资源库开合、快捷选择与统计同步脚本**

  在现有脚本末尾添加：

  ```js
  function wireResource(id, listId) {
    const root = document.getElementById(id);
    const body = root.querySelector('.resource-body');
    const toggle = root.querySelector('.resource-import');
    toggle.onclick = () => {
      const open = !body.classList.contains('is-open');
      body.classList.toggle('is-open', open);
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    };
    root.querySelector('.resource-select').onclick = () => {
      document.querySelector(`#${listId} button`)?.click();
    };
  }
  wireResource('account-resource', 'acclist');
  wireResource('card-resource', 'cardlist');
  wireResource('address-resource', 'addrlist');
  ```

  在 `refreshAccounts`、`refreshCards`、`refreshAddresses` 成功取得列表后，分别更新 `#account-count`、`#card-count`、`#address-count` 的 `textContent` 为 `list.length`。保留现有 `renderLib`，以便选择弹窗与回填行为不变。

- [ ] **Step 6: 重新加载本地页面，运行 E2E 测试**

  Run: `node test/e2e.mjs http://127.0.0.1:3456`

  Expected: 新的工作台、资源展开断言与原有账号/卡/地址导入、选择、地址生成、四种执行及三种清空测试均通过。

- [ ] **Step 7: 记录实现检查点**

  本目录不是 Git 仓库，不能创建提交；使用 `git diff` 前先确认仓库状态，改用 `Get-Content` 与 E2E 输出记录本轮变更。

### Task 3: 浏览器视觉与响应式验证

**Files:**
- Modify: `C:/Users/h/Desktop/dipay/public/index.html`（仅在验证发现布局问题时）
- Test: `C:/Users/h/Desktop/dipay/test/e2e.mjs`

- [ ] **Step 1: 在 1440px 宽度检查默认工作台**

  打开 `http://127.0.0.1:3456/`，确认左侧任务区、右侧资源库/日志区、三张统计卡、淡橘主操作和浅红批量支付全部可见，且没有横向滚动。

- [ ] **Step 2: 展开账号、卡和地址的导入区**

  逐项点击资源库的「导入」，确认每项只展开自己的文件输入、批量粘贴和导入/清空控件；点击「查看/选择」确认仍出现现有模态框。

- [ ] **Step 3: 在 768px 宽度检查窄屏布局**

  将视口调为 768px，确认任务区位于资源库和日志之前，所有按钮文字可读，输入框与资源行没有重叠或截断。

- [ ] **Step 4: 运行最终 E2E 验证**

  Run: `node test/e2e.mjs http://127.0.0.1:3456`

  Expected: 退出码 `0`，输出的失败数为 `0`。

- [ ] **Step 5: 记录最终检查点**

  本目录没有 `.git`，因此不执行提交。交付时说明修改的前端和测试文件、已验证的命令与结果。
