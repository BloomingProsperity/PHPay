# dipay — ChatGPT 菲律宾区订阅项目研究

## 功能

- 协议化支付：session JSON + 卡 + 地址 → 自动完成订阅支付
- 资源库严格文件导入：账号支持 JSON/TXT，卡和地址支持 JSON/CSV/TXT；每个文件单独解析，错误行拒绝入库且不回显敏感内容
- 资源选择：账号、卡、地址均以脱敏列表显示，单笔任务可明确选择资源；手动填写卡/地址保留为备用折叠区
- 临时地址：单笔操作没有地址时，页面生成一条“本次临时地址”；默认不入库，只有明确点击保存才写入地址库
- 三库联动：资源库与单笔选择分开；批量功能仍使用其既有资源库范围
- 生成链接：结账链接 / pay.openai.com 托管链接 / GCash 链接
- 批量生成链接：session JSON 放入 `accounts/` 目录批量处理，结果写入 `out/`
- 套餐：Go / Plus / Pro 5x / Pro 20x / Team

## 部署

```bash
cd dipay
vi config/card.json
docker compose up -d --build
```

打开 `http://127.0.0.1:3456`

本地运行：

```bash
npm install
node src/server.js
```

## 使用

1. 提供账号凭证，粘贴到页面（三种格式自动识别）：
   - **session JSON**：登录 chatgpt.com 后访问 `https://chatgpt.com/api/auth/session`，复制整段返回
   - **accessToken**：上述 JSON 中 `accessToken` 字段的值，或 DevTools → Network 请求头 `Authorization: Bearer` 中的值
   - **sessionToken**：DevTools → Application → Cookies → `__Secure-next-auth.session-token` 的值
2. 「仅生成链接」：输出支付链接，发给客户自行支付
3. 「立即支付」：用 config 中的卡完成支付
4. 「批量生成链接」：多个 session JSON 放入 `accounts/` 后点击
5. 「批量支付」：账号库 + 卡库 + 地址库按序号自动配对执行

## API

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康检查 |
| `GET /api/defaults` | config 默认值 |
| `GET /api/cards` | 卡库列表 |
| `POST /api/resources/:kind/import` | 严格导入单个文件（`:kind` 为 `accounts`、`cards`、`addresses`；body: `{file:{name,text}}`） |
| `POST /api/resources/:kind/use` | 读取用户明确选择的一条资源（body: `{id}`） |
| `GET /api/addresses` | 地址库列表 |
| `POST /api/addresses/temporary` | 生成一条不落库的单笔临时地址 |
| `GET /api/batch-pay?plan=chatgptpro&conc=5` | 批量支付：账号×卡×地址按序配对，并发可配（SSE） |
| `GET /api/pay?payload=<json>` | 支付（SSE） |
| `GET /api/link?payload=<json>` | 生成链接（SSE） |
| `GET /api/batch-links?plan=chatgptpro` | 批量生成（SSE） |

payload: `{ sessionJson, card: {number,exp,cvc,name}, address: {line1,city,state,zip,country}, plan }`

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 端口 | 3456 |
| `HTTPS_PROXY` | 全局出口代理（Stripe 请求；chatgpt 请求在 `CF_PROXY` 未配时也走这里） | 无（直连） |
| `CF_PROXY` | chatgpt.com 请求专用代理（curl_cffi，优先级高于 `HTTPS_PROXY`） | 无（用 `HTTPS_PROXY`） |
| `PROXY_POOL` | 代理池，逗号分隔多个代理；批量任务按序号分配不同出口 IP | 无（用单代理） |
| `BROWSER_WS_ENDPOINT` | 外部 Chrome CDP 地址 | 无（用内置 Chromium） |
| `CHROME_PATH` | Chromium 路径 | 自动 |
