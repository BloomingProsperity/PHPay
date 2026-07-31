# PHPay

PHPay 是一个本地 Docker 部署的订阅支付与资源管理工具。账号、支付卡、地址、任务记录和验证配置均保存在部署者自己的电脑上。

## 一键部署

### Windows

1. 安装并启动 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。
2. 下载或克隆本项目。
3. 双击 `start.bat`。
4. 启动成功后会自动打开 `http://127.0.0.1:3456`。

### Linux / macOS

```bash
git clone https://github.com/BloomingProsperity/PHPay.git
cd PHPay
chmod +x deploy.sh
./deploy.sh
```

也可以直接运行：

```bash
docker compose up -d --build
```

## 代理自动配对

部署脚本按以下顺序寻找代理：

1. 手动传入的 `PHPAY_PROXY`
2. 系统环境变量 `HTTPS_PROXY`
3. 系统环境变量 `HTTP_PROXY`
4. 系统环境变量 `ALL_PROXY`
5. Windows 当前用户的系统代理设置

代理为 `127.0.0.1`、`localhost` 或 `::1` 时，脚本会自动转换为容器可访问的 `host.docker.internal`。没有检测到代理时直接使用当前网络，不会阻止项目启动。

如需手动指定：

```powershell
.\deploy.ps1 -Proxy "http://127.0.0.1:7890"
```

或复制 `.env.example` 为 `.env`，填写：

```dotenv
PHPAY_PROXY=http://host:port
```

UI 中保存的代理池优先于自动检测到的单代理；因此部署后仍可在页面中导入和管理多条代理。

## 常用命令

```bash
# 查看状态
docker compose ps

# 查看日志
docker compose logs -f

# 停止
docker compose down

# 更新代码后重新部署
git pull
docker compose up -d --build
```

## 本地数据

以下目录不会提交到 GitHub：

- `accounts/`
- `cards/`
- `addresses/`
- `payment-tasks/`
- `config/`
- `out/`

重新构建容器不会删除这些目录。迁移电脑时，请单独备份它们。

## 可选环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `PHPAY_PROXY` | 自动检测结果的手动覆盖；仅支持 HTTP/HTTPS | 空，直连 |
| `PROXY_POOL` | 英文逗号分隔的代理池 | 空 |
| `BROWSER_WS_ENDPOINT` | 外部 Chrome CDP 地址 | 空 |
| `CHROME_PATH` | Chromium 路径 | 自动 |
| `SOLVER_API_KEY` | 备用验证服务密钥 | 空 |

## 安全说明

仓库不会包含本地账号、支付卡、地址、代理密码、验证密钥或历史支付任务。请勿手动把上述运行目录加入 Git。
