# Docker 部署

## 前置条件

| 依赖 | 说明 |
|------|------|
| Docker + Compose | 本机或服务器已安装 |
| Upstash Redis | `.env` 中 `REDIS_URL=rediss://...` |
| LINUX DO OAuth | Client ID/Secret + **公网回调地址** |
| 平台 LLM（主站直连） | `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` |
| 工具网关（用户自定义 API + 搜索） | `TOOLS_BASE_URL` / `TOOLS_API_KEY`；镜像见 `huggingface/wechat-ai-tools` |


## 快速启动

```bash
cd /path/to/WeChat-AI

# 配置环境变量（勿提交 .env）
# 生产务必修改：
#   PUBLIC_BASE_URL=https://你的域名
#   LINUXDO_REDIRECT_URI=https://你的域名/api/v1/auth/callback
#   REDIS_URL / LLM_* / LINUXDO_CLIENT_*
# 用户自定义 API + 搜索：TOOLS_BASE_URL / TOOLS_API_KEY
#   docker compose --profile tools up -d --build
#   TOOLS_BASE_URL=http://wechat-ai-tools:7860

# 推荐：升版 + 打 OTA 包 + 构建（无需 Cookie）
pnpm docker:up
# 自定义镜像名：
pnpm docker:build -- -- docker build -t your-dockerhub-user/wechat-ai:latest .

# 包在 dist/release/<版本>/files.json
# 浏览器登录 /admin → 部署节点 →「上传通道包」→ 再点节点「更新」

docker compose logs -f wechat-ai
```

仓库内的 Dockerfile 默认使用国内镜像：`docker.1panel.live` 基础镜像、
`registry.npmmirror.com` npm 源、阿里云 Debian/PyPI 源。Debian 引导源使用
HTTP 以便在极简基础镜像尚无 CA 证书时先安装 `ca-certificates`；APT 仍会通过
Debian GPG 签名验证仓库元数据。日常部署无需再传
镜像源参数；如在其他网络环境构建，可用 `NPM_REGISTRY`、`DEBIAN_MIRROR`
或 `PIP_INDEX_URL` build arg 覆盖。

### 单独构建 tools 镜像

```bash
docker build -t wechat-ai-tools:latest -f huggingface/wechat-ai-tools/Dockerfile huggingface/wechat-ai-tools
docker run --rm -p 7860:7860 -e TOOLS_API_KEY=secret -e ALLOW_REQUEST_UPSTREAM=true wechat-ai-tools:latest
```

详见 `docs/ai-gateway.md`、`huggingface/wechat-ai-tools/README.md`。


> **版本与通道：** `pnpm docker:build` 默认：升版 → **本地 pack** → Docker。  
> 通道发布只走网页：`/admin` → 上传 `files.json`（无 CLI Cookie）。  
> 直接跑 `docker build` **不会**升版、也**不会**打通道包。

| 地址 | 说明 |
|------|------|
| `/` | 功能介绍落地页（OG 分享图 `/og.jpg`） |
| `/app` | 用户中心（LINUX DO 登录、加机器人） |
| `/admin` | 管理后台（仪表盘 / Token） |
| `/health` | 健康检查 |

## 仅用 Dockerfile

```bash
# 升版 + docker build -t wechat-ai .
pnpm docker:build -- --raw
# 或自定义：node scripts/docker-build.mjs -- docker build -t wechat-ai:0.2.1 .

docker run -d --name wechat-ai --restart unless-stopped \
  --env-file .env \
  -e WECHAT_AI_HOST=0.0.0.0 \
  -e WECHAT_AI_PORT=8787 \
  -p 8787:8787 \
  wechat-ai
```

Bot token 与表情包均存 **Redis**（与 `REDIS_URL` 同库），容器重建不丢；无需本地数据卷。

## 生产环境检查清单

1. **LINUX DO** 应用回调与 `.env` 完全一致：  
   `https://你的域名/api/v1/auth/callback`
2. **`PUBLIC_BASE_URL`** = `https://你的域名`（无尾斜杠）
3. **HTTPS** 时设置 `COOKIE_SECURE=true`
4. **Redis** 使用 Upstash `rediss://`，服务器能访问外网
5. Bot **token 已写入 Redis**（与 `REDIS_URL` 同库），重建容器不会丢登录

## 常用命令

```bash
docker compose ps
docker compose logs -f
docker compose restart
docker compose down          # 停服务（Bot token 在 Redis，不受影响）
docker compose down -v       # 同 down（本服务无持久化 volume）
pnpm docker:up                                # 升版+本地 pack+compose up --build
pnpm docker:build -- -- docker build -t your-dockerhub-user/wechat-ai:latest .
# 然后 /admin → 上传通道包 (files.json) → 更新节点
pnpm docker:build -- --no-channel             # 只升版构建，不 pack
```

## OTA 增量更新（多节点日常热修）

业务源码小改可不必每台 `docker build`：本地 pack → 管理后台上传通道包 → 对落后节点点「更新」。

```bash
# 构建顺带打通道包
pnpm docker:build -- -- docker build -t your-dockerhub-user/wechat-ai:latest .
# 或仅 pack：
pnpm release:pack

# 浏览器 /admin → 部署节点 →「上传通道包」选 dist/release/<ver>/files.json
# →「更新全部落后」
```

| 项 | 说明 |
|----|------|
| 差量 | 按文件 sha256 比对，只下发变更文件 |
| 重启 | 节点 `process.exit(0)`，依赖 `restart: unless-stopped` 拉起**同一容器**（可写层保留补丁） |
| 版本 | 心跳 `version`：`.wa-version`（OTA 写入）→ `APP_VERSION` → 根 `package.json` |
| 仍需镜像 | Node 基础镜像、系统包、Dockerfile、`OTA_ALLOW_INSTALL=false` 时的依赖大变 |

环境变量：`OTA_ENABLED`（默认 true）、`OTA_ALLOW_INSTALL`、`APP_VERSION`（无 OTA 戳时可选）、`OTA_STAGING_DIR`。  
**注意：** OTA 只改文件、不改环境变量；版本靠 `/app/.wa-version` 上报，无需、也不应靠 `APP_VERSION` 跟版。  
`docker compose up --build` / 重建容器会丢掉仅靠 OTA 写入的补丁；长期仍以镜像为 source of truth。

## 反代示例

生产推荐把域名挂在 **Cloudflare**（橙云代理 + Cache Rules），见 **`docs/cloudflare.md`**（Business 缓存规则、忽略 Cookie、Purge 清单）。

### Caddy（无 CF 时）

```caddy
your.domain.com {
  reverse_proxy 127.0.0.1:8787
}
```

### Nginx（无 CF 时，或 CF → Nginx → Node）

```nginx
server {
  listen 443 ssl;
  server_name your.domain.com;
  # ssl_certificate ...;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Cloudflare 还原真实 IP 时可用：
    # proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
  }
}
```

源站已输出 `Cache-Control` / `Cloudflare-CDN-Cache-Control`、HTML ETag、公开表情 `/cdn/s/:id?v=`。反代层**不必**再写 `proxy_cache`，除非你不用 Cloudflare。
## 镜像说明

- 基础镜像：`node:22-bookworm-slim`
- 包管理：pnpm monorepo
- 启动：`pnpm db:seed`（幂等）→ `pnpm --filter @wechat-ai/api start`（**API + Worker 同进程**）
- 非 root 用户 `appuser` 运行
- 健康检查：`GET /health`

## Worker 规模（单镜像）

默认仍是 **一个容器跑全部**：HTTP + iLink 长轮询 + AI 回复。

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `MAX_BOTS_PER_WORKER` | `500` | 本进程最多同时 long-poll 的 bot 数 |
| `REPLY_CONCURRENCY` | `16` | 同时进行的 LLM/发送任务数 |
| `LEASE_TTL_SEC` | `45` | 租约 TTL（同镜像多副本时防重复 poll） |

机器人很多时优先调高 `MAX_BOTS_PER_WORKER` 与系统 `ulimit -n`（注意内存与出站连接数）。  
默认 **单副本一体部署** 即可；同镜像多副本已支持（Redis 租约分片 poll）。

## 多节点同构部署（10+ 台）

每台服务器跑**同一镜像**（API + Worker），共用一个 Upstash Redis；用户只访问**主域名**。

### 应用 env（全站一致）

```env
PUBLIC_BASE_URL=https://你的主域名
LINUXDO_REDIRECT_URI=https://你的主域名/api/v1/auth/callback
REDIS_URL=rediss://...
COOKIE_SECURE=true
WORKER_ENABLED=true
```

### 每节点不同

```env
WORKER_ID=node-01          # 必填且唯一
NODE_LABEL=cn-east-1a      # 可选，管理后台展示
NODE_REGION=cn-east        # 可选
```

**不要**给每台设不同的 `PUBLIC_BASE_URL`。源站直连地址（IP:8787）只写在 Cloudflare Worker 的 `ORIGINS`，见 `cloudflare-worker/README.md`。

### 部署步骤摘要

1. 各机：`docker run ... --env-file .env -e WORKER_ID=node-0N -p 8787:8787 wechat-ai`  
2. 配置并部署 `cloudflare-worker`，`ORIGINS=http://ip1:8787,http://ip2:8787,...`  
3. 主域名绑到 Worker  
4. 打开 `/admin` → **节点**：应看到各 `WORKER_ID` 心跳与租约 bot 数  

| 探活 | 路径 |
|------|------|
| Docker / 轻量 | `GET /health` |
| LB 就绪（含 Redis） | `GET /health/ready` |

管理 API：`GET /api/v1/admin/nodes`（Cookie 管理员）。

扫码加机器人会话状态在 Redis，HTTP 无需粘性会话。

### 租约自动再平衡（rebalance）

多节点默认 **开启**：租约偏多的进程会周期性 **主动释放** 多余 lease（不 pause bot），空闲节点下一轮 `claim` 捡走，使各节点 bot 数接近均分。

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `REBALANCE_ENABLED` | `true` | 设为 `false` 关闭（租约粘在首占节点） |
| `REBALANCE_INTERVAL_SEC` | `60` | 同一进程两次 shed 最小间隔 |
| `REBALANCE_SLACK` | `2` | 允许高出均分多少个再释放 |
| `REBALANCE_MAX_PER_TICK` | `50` | 每次最多释放数（避免瞬间空窗过大） |

日志关键字：`[worker] rebalance shed N bot(s)`。约 `ceil(超额 / 50)` 分钟内收敛。

### 强制下线节点

管理后台 **节点** 页 → **强制下线**：

1. 写入 Redis fence（`wa:worker:{id}:fence`）  
2. 释放该 WORKER_ID 下全部 bot 租约  
3. 从 `wa:workers:reg` 移除  

目标进程下一轮 reconcile 发现 fence 后停止认领；其他节点 claim 这些 bot。  
**解除下线** 后该节点可重新加入。  

这**不会** `docker stop`；若要从 LB 摘流量，还要从 Cloudflare Worker `ORIGINS` 去掉该源站。
