// dipay 全按钮端到端测试（真实 Chrome + 运行中的服务）
// 用法: node test/e2e.mjs [baseURL]   默认 http://127.0.0.1:3456
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://127.0.0.1:3456';
let baseUrl;
try {
  baseUrl = new URL(BASE);
} catch {
  console.error(`Refusing to run E2E with an invalid base URL: ${BASE}`);
  process.exit(1);
}
// The default command is safe: resource resets require the exact opt-in below.
if (process.env.E2E_ALLOW_DESTRUCTIVE !== '1') {
  console.error('Refusing to clear resource libraries. Re-run with E2E_ALLOW_DESTRUCTIVE=1 against an isolated test server.');
  process.exit(1);
}
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
if (!loopbackHosts.has(baseUrl.hostname.toLowerCase()) && process.env.E2E_ALLOW_REMOTE !== '1') {
  console.error(`Refusing to clear non-loopback resource libraries at ${baseUrl.hostname}. Re-run with E2E_ALLOW_REMOTE=1 only for an isolated remote test server.`);
  process.exit(1);
}
// 先清空三个库，保证测试环境干净
for (const ep of ['accounts', 'cards', 'addresses']) {
  await fetch(`${BASE}/api/${ep}/clear`, { method: 'POST' });
}
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}

const FAKE_ACCT = (n) => JSON.stringify({ accessToken: 'fake-token-' + n, user: { email: `e2e-${n}@example.com` } });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('dialog', d => d.accept()); // 批量支付的 confirm 自动确认
const closeModal = async () => {
  await page.locator('#modal-mask').click({ position: { x: 1, y: 1 } });
  await page.waitForSelector('#modal-mask.show', { state: 'hidden' });
};

try {
  console.log('== 页面加载 ==');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  check('标题', (await page.textContent('h1')) === 'dipay');
  check('工作台主区域存在', await page.locator('.workspace').count() === 1);
  check('资源库含账号导入入口', await page.locator('#account-resource .resource-import').count() === 1);
  check('资源库含卡导入入口', await page.locator('#card-resource .resource-import').count() === 1);
  check('资源库含地址导入入口', await page.locator('#address-resource .resource-import').count() === 1);
  check('日志位于状态面板', await page.locator('.status-panel #log').count() === 1);
  check('套餐自定义选择器存在', await page.locator('#plan-picker-trigger').count() === 1);
  await page.click('#plan-picker-trigger');
  await page.waitForSelector('#plan-picker-menu.is-open');
  check('套餐选择层可展开', await page.locator('#plan-picker-menu').isVisible());
  await page.click('#plan-picker-menu [data-plan="chatgptplusplan"]');
  check('套餐值与自定义选择器同步', await page.inputValue('#plan') === 'chatgptplusplan');
  check('选择套餐后选择层关闭', !(await page.locator('#plan-picker-menu').isVisible()) && await page.locator('#plan-picker-trigger').getAttribute('aria-expanded') === 'false');
  await page.click('#plan-picker-trigger');
  await page.keyboard.press('Escape');
  check('Escape 关闭套餐选择层', !(await page.locator('#plan-picker-menu').isVisible()) && await page.locator('#plan-picker-trigger').getAttribute('aria-expanded') === 'false');
  await page.click('#plan-picker-trigger');
  await page.click('h1');
  check('点击外部关闭套餐选择层', !(await page.locator('#plan-picker-menu').isVisible()) && await page.locator('#plan-picker-trigger').getAttribute('aria-expanded') === 'false');
  await page.evaluate(() => {
    const nativePlan = document.getElementById('plan');
    nativePlan.value = 'chatgptgoplan';
    nativePlan.dispatchEvent(new Event('change', { bubbles:true }));
  });
  check('原生套餐变更同步自定义标签', (await page.textContent('#plan-picker-trigger')).includes('Go'));
  check('套餐触发器关联可访问标签和菜单', await page.locator('#plan-picker-trigger').getAttribute('aria-labelledby') === 'plan-picker-label' && await page.locator('#plan-picker-trigger').getAttribute('aria-controls') === 'plan-picker-menu');
  await page.focus('#plan-picker-trigger');
  await page.keyboard.press('ArrowDown');
  check('下箭头打开套餐选择层', await page.locator('#plan-picker-menu').isVisible());
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  check('箭头导航后 Enter 选择套餐并回到触发器', await page.inputValue('#plan') === 'chatgptprolite' && !(await page.locator('#plan-picker-menu').isVisible()) && await page.evaluate(() => document.activeElement.id === 'plan-picker-trigger'));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  check('键盘 Escape 关闭选择层并返回触发器', !(await page.locator('#plan-picker-menu').isVisible()) && await page.evaluate(() => document.activeElement.id === 'plan-picker-trigger'));
  check('侧栏面板与状态内容边缘对齐', await page.evaluate(() => {
    const resource = document.querySelector('.resource-panel').getBoundingClientRect();
    const status = document.querySelector('.status-panel').getBoundingClientRect();
    const bar = document.getElementById('bar').getBoundingClientRect();
    const log = document.getElementById('log').getBoundingClientRect();
    const links = document.getElementById('links').getBoundingClientRect();
    return Math.abs(resource.width - status.width) < 1 &&
      Math.abs(bar.left - log.left) < 1 && Math.abs(log.left - links.left) < 1 &&
      Math.abs(bar.right - log.right) < 1 && Math.abs(log.right - links.right) < 1 &&
      getComputedStyle(document.getElementById('log')).margin === '0px';
  }));
  for (const id of ['account-resource', 'card-resource', 'address-resource']) {
    await page.click(`#${id} .resource-select`);
    await page.waitForSelector('#modal-mask.show');
    check(`${id} 空库查看/选择也打开弹窗`, await page.locator('#modal-mask.show').isVisible());
    await closeModal();
  }

  console.log('== 账号：批量导入（粘贴，空行分隔 2 个） ==');
  await page.click('#account-resource .resource-import');
  await page.waitForSelector('#account-resource .resource-body.is-open');
  check('账号导入面板可展开', await page.locator('#account-resource .resource-body.is-open').isVisible());
  check('账号批量输入仍可用', await page.locator('#account-resource #bulk').isVisible());
  await page.fill('#bulk', FAKE_ACCT(1) + '\n\n' + FAKE_ACCT(2));
  await page.click('#import');
  await page.waitForFunction(() => document.getElementById('acctstat').textContent.includes('成功导入'), null, { timeout: 30000 });
  check('状态显示成功导入 2 个', await page.evaluate(() => document.getElementById('acctstat').textContent.includes('成功导入 2')));
  await page.waitForFunction(() => document.getElementById('acclist').textContent.includes('账号库 2 个'));
  check('页面只显示账号总数', true);
  check('账号总数卡更新为 2', (await page.textContent('#account-count')) === '2');
  await page.click('#account-resource .resource-select');
  await page.waitForSelector('#modal-mask.show');
  check('账号库有数据时查看/选择打开弹窗', await page.locator('#modal-mask.show').isVisible());
  await closeModal();
  await page.click('#acclist button');
  await page.waitForSelector('#modal-mask.show');
  check('弹窗按序列出账号名', await page.evaluate(() => {
    const items = [...document.querySelectorAll('#modal-items .item')];
    return items.length === 2 && items[0].textContent.includes('e2e-1@example.com') && items[1].textContent.includes('e2e-2@example.com');
  }));
  await page.click('#modal-items .item >> nth=0');
  check('点击账号填充 session', (await page.inputValue('#sess')).includes('fake-token'));

  console.log('== 卡：文件 + 粘贴合并导入 ==');
  await page.click('#card-resource .resource-import');
  await page.waitForSelector('#card-resource .resource-body.is-open');
  check('卡导入面板可展开', await page.locator('#card-resource .resource-body.is-open').isVisible());
  check('卡批量输入仍可用', await page.locator('#card-resource #cardbulk').isVisible());
  await page.setInputFiles('#cardfiles', {
    name: 'e2e-card.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('5555555555554444|06/28|456\n')
  });
  await page.fill('#cardbulk', '4242424242424242|12|2027|123|John Doe');
  await page.click('#cardimport');
  await page.waitForFunction(() => document.getElementById('cardstat').textContent.includes('成功导入'), null, { timeout: 15000 });
  check('合并导入成功 2 张（文件1+粘贴1）', await page.evaluate(() => document.getElementById('cardstat').textContent.includes('成功导入 2')));
  await page.waitForFunction(() => document.getElementById('cardlist').textContent.includes('卡库 2 张'));
  check('卡总数卡更新为 2', (await page.textContent('#card-count')) === '2');
  await page.click('#card-resource .resource-select');
  await page.waitForSelector('#modal-mask.show');
  check('卡库有数据时查看/选择打开弹窗', await page.locator('#modal-mask.show').isVisible());
  await closeModal();
  await page.click('#cardlist button');
  await page.waitForSelector('#modal-mask.show');
  check('卡弹窗只显示尾号四位', await page.evaluate(() =>
    [...document.querySelectorAll('#modal-items .item')].every(el => /…\d{4}/.test(el.textContent) && !/\d{6}/.test(el.textContent.replace(/…\d{4}/, '')))));
  await page.click('#modal-items .item >> nth=0');
  check('点击卡填充卡号', /^\d{13,19}$/.test(await page.inputValue('#num')));
  check('无名卡自动生成姓名', (await page.inputValue('#name')).trim().length > 0);

  console.log('== 地址：批量导入 + 点击填充 ==');
  await page.click('#address-resource .resource-import');
  await page.waitForSelector('#address-resource .resource-body.is-open');
  check('地址导入面板可展开', await page.locator('#address-resource .resource-body.is-open').isVisible());
  check('地址批量输入仍可用', await page.locator('#address-resource #addrbulk').isVisible());
  await page.fill('#addrbulk', '123 Rizal St|Manila|Metro Manila|1000|PH\n456 Oak Ave, Cebu City, 6000, PH');
  await page.click('#addrimport');
  await page.waitForFunction(() => document.getElementById('addrstat').textContent.includes('成功导入 2'), null, { timeout: 15000 });
  check('状态显示成功导入 2 条', true);
  await page.waitForFunction(() => document.getElementById('addrlist').textContent.includes('地址库 2 条'));
  await page.click('#addrlist button');
  await page.waitForSelector('#modal-mask.show');
  await page.click('#modal-items .item >> nth=0');
  check('点击地址填充', (await page.inputValue('#line1')).length > 0 && (await page.inputValue('#country')) === 'PH');

  console.log('== 地址：内置免税州生成器 ==');
  await page.fill('#genn', '3');
  await page.selectOption('#genstate', 'OR');
  await page.click('#addrgen');
  await page.waitForFunction(() => document.getElementById('addrstat').textContent.includes('已生成 3'), null, { timeout: 15000 });
  check('生成 3 条入库', true);
  await page.waitForFunction(() => document.getElementById('addrlist').textContent.includes('地址库 5 条'));
  check('地址库累计 5 条（导入2+生成3）', true);
  check('地址总数卡更新为 5', (await page.textContent('#address-count')) === '5');
  await page.click('#address-resource .resource-select');
  await page.waitForSelector('#modal-mask.show');
  check('地址库有数据时查看/选择打开弹窗', await page.locator('#modal-mask.show').isVisible());
  await closeModal();

  const waitDone = async () => {
    await page.waitForFunction(() =>
      document.getElementById('log').textContent.match(/完毕|中断|被拒|未成功|成功/) &&
      !document.getElementById('pay').disabled, null, { timeout: 120000 });
  };

  console.log('== 立即支付（假账号，验证 SSE 流程与按钮恢复） ==');
  await page.click('#pay');
  check('执行中按钮禁用', await page.evaluate(() => document.getElementById('pay').disabled));
  await waitDone();
  check('流程结束按钮恢复', true);
  check('日志有输出', (await page.textContent('#log')).length > 10);

  console.log('== 仅生成链接 ==');
  await page.click('#link');
  await waitDone();
  check('流程结束按钮恢复', true);

  console.log('== 批量生成链接 ==');
  await page.click('#batch');
  await page.waitForFunction(() => document.getElementById('log').textContent.includes('完毕') && !document.getElementById('batch').disabled, null, { timeout: 120000 });
  check('批量链接完毕', true);

  console.log('== 批量支付（配对提示 + confirm 自动确认） ==');
  await page.click('#batchpay');
  await page.waitForFunction(() => document.getElementById('log').textContent.includes('配对'), null, { timeout: 15000 });
  check('显示配对信息', true);
  await page.waitForFunction(() => document.getElementById('log').textContent.includes('完毕') && !document.getElementById('batchpay').disabled, null, { timeout: 180000 });
  check('批量支付完毕', true);

  console.log('== 三个清空按钮 ==');
  await page.click('#cardclear');
  await page.waitForFunction(() => document.getElementById('cardlist').textContent.includes('卡库为空'));
  check('清空卡库', true);
  check('清空卡库后总数为 0', (await page.textContent('#card-count')) === '0');
  await page.click('#addrclear');
  await page.waitForFunction(() => document.getElementById('addrlist').textContent.includes('地址库为空'));
  check('清空地址库', true);
  check('清空地址库后总数为 0', (await page.textContent('#address-count')) === '0');
  await page.click('#clear');
  await page.waitForFunction(() => document.getElementById('acclist').textContent.includes('账号库为空'));
  check('清空账号库', true);
  check('清空账号库后总数为 0', (await page.textContent('#account-count')) === '0');
} catch (e) {
  failed++;
  console.log('  FAIL 异常中断:', e.message);
} finally {
  await browser.close();
}
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
