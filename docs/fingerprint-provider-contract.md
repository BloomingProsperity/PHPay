# 指纹库接入契约

## 目的

支付调度、代理调度和支付状态机不应该知道指纹库的文件格式或实现细节。指纹库通过一个稳定提供器端口接入；以后完成指纹库后，只替换提供器数据源和网络边界映射即可直接进行模拟接线测试。

当前阶段只建立端口和测试替身，继续使用系统现有默认指纹，不改变 TLS、Cloudflare 或支付行为。

## 数据结构

```js
{
  id: 'fp_chrome_131_a',
  label: 'Chrome 131 / Windows',
  impersonation: 'chrome131',
  userAgent: 'Mozilla/5.0 ...', // 可选
  headers: {                   // 可选、私有
    'sec-ch-ua': '...'
  },
  metadata: {                  // 可选、私有
    platform: 'Windows'
  }
}
```

要求：

- `id` 在同一个部署内稳定、唯一。
- `label` 可以展示，不包含 Cookie、token 或其他账号信息。
- `impersonation` 必须是网络实现能够识别的 TLS profile 名称。
- `headers` 和 `metadata` 只保存在任务私有快照中。
- 指纹不永久绑定账号。

## 提供器接口

文件入口：`src/fingerprint-provider.js`

```js
const provider = createFingerprintProvider({
  loadProfiles,
  fallbackProfile
});

provider.snapshot();
provider.acquire({ ownerId, ordinal });
provider.release(ownerId);
provider.publicView();
```

### `snapshot()`

返回本次调度使用的稳定数组副本。运行中修改指纹库不影响已创建任务。

### `acquire({ ownerId, ordinal })`

从 `ordinal` 对应位置开始向下查找：

1. 优先选择未被其他任务占用的指纹。
2. 到底后回到顶部。
3. 全部正在使用时，从 `ordinal % count` 开始复用。
4. 返回值中的 `reused` 表示是否发生软锁复用。
5. 指纹不足永远不让任务排队。

### `release(ownerId)`

释放该任务的优先占用标记。因为是软锁，即使某指纹正在复用，也只移除该 owner 的记录。

### `publicView()`

只返回：

```js
{
  count,
  items: [{ id, label }],
  mode: 'default' | 'library'
}
```

不得返回 headers、metadata、完整 UA 客户端提示或任何凭证。

## 任务快照

任务私有数据：

```js
{
  fingerprintId,
  fingerprintProfile
}
```

公共任务数据：

```js
{
  fingerprintId,
  fingerprintLabel,
  fingerprintReused
}
```

已经创建的任务始终使用自己的私有快照；指纹库重新排序、删除或更新只影响新任务。

## 网络接线

当前阶段：

```text
默认提供器
→ DEFAULT_IMPERSONATION
→ 现有 normalizeNetworkContext
→ 现有 curl_cffi / 浏览器逻辑
```

未来接入：

```text
指纹库
→ fingerprint-provider
→ 任务私有 fingerprintProfile
→ network-context 透传 impersonation
→ curl_cffi / 浏览器应用对应 profile、UA 和 headers
```

接入指纹库时允许修改：

- `src/fprints.js`
- `src/fingerprint-provider.js`
- `src/network-context.js`
- `src/browser.js`
- `cffetch.py`
- 指纹专用测试

不需要修改：

- 账号导入解析
- 卡库和地址库
- 代理硬租约
- 支付金额判断
- confirm 后防重复支付
- 3DS 等级轮询

## 直接接线测试

指纹库完成后先注入模拟网络，不进行真实支付：

1. 16 条指纹按 `1…16` 从上到下选择。
2. 并发 10 时优先取得 10 条不同指纹。
3. 只有 8 条指纹、并发 10 时，第 9、10 个任务复用第 1、2 条且不排队。
4. 串行任务继续按游标向下选择。
5. 同一任务安全重试保持原指纹快照。
6. 新任务读取更新后的指纹库，旧任务不变化。
7. 公共 API、日志和 UI 不包含私有 headers/metadata。
8. `effectiveImpersonation` 确实透传提供器返回值，不再固定覆盖为 `chrome131`。
9. 所有测试使用本地替身，不访问 ChatGPT、Stripe 或真实代理。

## 版本记录

- 2026-07-31：确定指纹为顺序软租约；本阶段预留提供器端口，未来指纹库可直接注入并进行模拟接线测试。
- 2026-07-31：增加只读 `/api/fingerprint-provider` 与 UI“指纹库接入口”；仅公开 ID、名称、顺序与软租约模式。
