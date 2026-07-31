# dipay 问题清单（2026-07-30 全链路排查）

## 复查后已解决（并行重构修复）

- ~~I-1 approve 轮换 16 次重复提交~~ → 轮换已整体删除，approve 单次 chrome131 → 挑战直接破盾
- ~~I-2 流程内指纹不连续~~ → 全链统一单一指纹 chrome131
- ~~I-3 已订阅账号重复购买~~ → `assertAccountCanSubscribe` 拦截 account_already_on_target_plan
- ~~I-10 前端 XSS~~ → 日志改为 textContent 构造，无 innerHTML 注入面
- 挑战检测升级：cf-mitigated 头 + 状态码 + HTML 文本多信号（优于原 content-type 单信号）
- solver 重写：只认 cf_clearance、重放前清理旧 cookie/UA、668 行完备实现

## P0 现存

### N-1 日常指纹 chrome131 是实测最差的选型
- 位置：`fprints.js`（池已删）、`cffetch.py`（硬编码）、`network-context.js`（void 入参）
- 事实：chrome131 在 CF 严格期 3/3 被拦（edge99/safari 系 3/3 通过）；CF 一旦收紧，100% 流量坠入浏览器破盾（2-5s/请求且可能失败），已无轮换退路
- 建议：日常指纹换实测最优（edge99/safari18_0），保留小池做挑战时 fallback

### N-2 runPay 的 skipPromo 被写死，opt-out 失效
- 位置：`payment.js:252-254`（`void skipPromo;` 后 `skipPromo: true`）
- 现象：payload 传 `skipPromo:false` 无效（runLink 有效）；想给客户用免费月无法关闭绕过

## P1 现存

### N-3 测试红 2 处：代理 URL 尾斜杠
- 位置：`payment-task-store.js networkProxy`（`url.toString()` 自动补 `/`）vs `test/resource-api.test.mjs` 期望无尾杠
- 性质：规范化不一致，cosmetic，但套件红

### N-5 solver cookie 跨账号共享（I-6 未确认修复）
- solver.js 重写后缓存键未完全审阅；若仍按 origin+proxy，同代理多账号关联风险仍在

### N-6 账号状态双检（I-8 未修）
- 批量前置过滤（库存状态）+ runPay 实时检，每单多一发 accounts/check；emitAccountStatus 传 token 但 detect 内部对 sessionToken 型账号会二次兑换

### N-7 地址无隔离（I-7 未修）
- 地址游标循环，一址可挂多号

### N-8 cffetch 每请求 spawn（I-9 未修）
- 100-300ms/请求，可改常驻进程

### N-9 e2e 两处历史失败
- 抽屉导入流 vs 旧测试期望；侧栏几何对齐（并行 UI 重构自身冲突）

## 遗留观察项

- Sentinel Turnstile：VM 与参照实现输出一致，支付路径暂不需要；强制校验时接匿名端点流程
- PoW 算法：目前通过；若 OpenAI 校验 config 字段需切双 nonce 变体
- CapSolver：仅公网代理场景可用
