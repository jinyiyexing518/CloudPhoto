# CloudPhoto — 部署指南

本文档记录两套访问方案的架构与搭建流程。

---

## 方案一：直连 Azure（默认，国际访问）

| 组件 | URL |
|------|-----|
| 前端 | `https://brave-sand-053b07a00.7.azurestaticapps.net` |
| API | `https://cloudphoto-api.azurewebsites.net/api` |

### CI/CD 自动部署

- **前端**：推送 `packages/client/**` 或共享算法运行时代码/构建元数据变更时 `.github/workflows/deploy-frontend.yml` 自动触发，`VITE_API_BASE` 从 GitHub Secret 读取
- **后端**：推送 `packages/server/**` 或共享算法运行时代码/构建元数据变更时 `.github/workflows/deploy-backend.yml` 自动触发
- 部署与同步 Workflow 均使用 `actions/setup-node@v7`、基于 Node 24 的 `azure/login@v3` 和 **OIDC Federated Credential**，无任何长期密码；前端跨 job 产物固定使用 Node 24 的 `actions/upload-artifact@v7` / `actions/download-artifact@v8`，保持 `frontend-dist` 名称、`packages/client/dist` 路径和 1 天 retention 不变；静态契约会阻止 Node 环境 Action、登录 Action、artifact Action 或目标 Node 运行时回退到弃用版本
- 前端生产分支只由 `main` push 或 `main` 上显式 `workflow_dispatch mode=production` 的 workflow/job/step hard condition 选择；SWA Action 不传 `production_branch`，PR 与非 `main` 手动运行仍只验证且不会取得生产 artifact 或执行 Azure upload
- 前端 Vite 配置使用 `.mts` ESM 入口并从 `import.meta.url` 解析源码别名；构建后的静态契约会拒绝旧 `.ts` 配置或 CommonJS `__dirname` 回归
- 共享算法触发面严格限定为 `packages/algorithm/src/**`、`package.json` 和 `tsconfig.json`；README 等不会改变部署产物的文件不触发生产重建

### 跨部署静态资产保留

前端构建后、SWA upload 前执行 `scripts/deployment-assets.mjs`。脚本从 Azure 直连入口读取 `deployment-assets.json`，只接受 `assets/*-<hash>.js|css`，逐项验证字节数与 SHA-256 后复制到新 `dist`。代次 ID 由 commit SHA、GitHub run ID 和 attempt 组成，保证同一 commit 重跑时前一构建的精确 hash 仍按独立代次保留。当前代排在首位，最多保留 24 个完整代次和 64 MiB 唯一 JS/CSS；达到任一上限即从最旧完整代次开始淘汰，不保留 source map，也不允许路径碰撞、摘要漂移或无限累积。

`packages/client/deployment-retention.json` 是唯一策略源。`revokedGenerationIds` 使用 `deployment-assets.json` 中的精确代次 ID 做安全回滚：历史代次会立即排除，若当前发布代次自身被撤销则部署直接失败。首次上线时旧 SWA 会把缺失 manifest 伪装成 `200 text/html`；bootstrap 仅接受 policy 固定的响应状态、MIME、入口 HTML 骨架 SHA-256 且受 `expiresAt` 限时。骨架计算只归一化恰好一个 content-hashed `index-*.js` 与 `index-*.css` 名称，其余 HTML 字节必须一致；模板漂移、多入口、真 404、非法 UTF-8 或过期响应都拒绝部署，不能静默缩短兼容窗口。workflow 使用 `fetch-depth: 50`，复用本次 workflow 已安装的前端工具链，从 policy 固定的历史 commit 执行 Vite 构建，并且只选取 `bootstrapGenerationAssets` 明列且精确 hash 文件名确实重建出的迁移资源；当前唯一条目是自然生成且与实证请求一致的 `AuthenticatedApp-BkGhvsE_.css`，不是旧 hash alias。受 build timestamp 影响的重建 JS 不进入 bootstrap；首轮之后历史 JS/CSS 都从线上读取原始字节。完成迁移后应删除 bootstrap source pin；若迁移资源发生安全撤销，则同时删除对应 bootstrap ref/assets/pin 并加入精确 revoked generation，禁止回建。

该保留层是旧客户端的必要恢复面：旧 active Service Worker 可能继续返回缓存的 `index.html`/入口 JS，根本不会执行当前 `deploymentRecovery.ts`。只要其代次仍在窗口内，新标签即可加载旧 app shell 的精确 lazy JS/CSS，waiting worker 保持 waiting，不强制接管其他标签或 PWA。超过窗口后的可信同源 chunk 失败才进入客户端一次性恢复；离线、`sessionStorage` 不可用或上传/下载/删除/语音/批量/回收站/维护/文件夹重命名进行中时自动刷新保持关闭。

### 上传内存与并发边界

`uploadPhoto` 在 `request.arrayBuffer()` 前检查 `Content-Length`，声明超出图片 20 MiB / 视频 200 MiB 时立即返回 413，缺失返回 411、非法返回 400；读取后再次校验真实字节数不超限且与声明一致。每个 Node Function 实例内有一个异常安全的加权准入器：

| 边界 | 权重 | 声明字节 |
|---|---:|---:|
| 单实例 | 3 | 256 MiB |
| 单用户/实例 | 3 | 220 MiB |

图片权重 1，视频或大文件权重 2。准入 lease 覆盖正文缓冲、Blob 写入、EXIF 与图片 thumbnail/preview 生成，所有返回和异常路径都在 `finally` 释放；活跃用户项归零即删除，状态表另有 1024 项硬上限。拒绝响应为 `429`，同时返回并跨域暴露 `Retry-After: 3`。

这是**单实例内存保护**，不是跨实例/分布式限流。当前没有给 `host.json` 增加全站 `maxConcurrentRequests`：该设置会同时影响认证、列表和下载票据等轻请求，而现有负载没有支持统一阈值的实测证据。若后续要调整平台 HTTP concurrency，必须先依据 Application Insights 的实例内存、请求并发和 429 数据单独评估。

客户端 4G 预算 3、未知/3G 预算 2、`saveData`/2G 预算 1；仅网络错误、408/425/429/5xx 自动重试，并读取上述 `Retry-After`。批次逻辑进度只把成功项补成完整文件，失败/取消项保留实际 loaded；重试和线路回退的实际传输字节另行单调累计用于 EMA 速度。settled 结果分别统计成功、失败和取消，部分成功仍刷新照片库且刷新完成前保持传输守卫。原文件下载路径不受此准入影响，仍由浏览器拿附件 SAS 后直连 Blob。

### 所需 GitHub Secrets

| Secret | 说明 |
|--------|------|
| `VITE_API_BASE` | 前端 API 基础 URL（见下方方案选择） |
| `AZURE_CLIENT_ID` | Service Principal Client ID |
| `AZURE_TENANT_ID` | Azure 租户 ID |
| `AZURE_SUBSCRIPTION_ID` | Azure 订阅 ID |

---

## 方案二：新加坡 VM 反向代理（中国大陆访问）

`azurewebsites.net` 和 `azurestaticapps.net` 在中国大陆访问不稳定。通过新加坡 VM 作为中转，所有流量走自定义域名，用户无需翻墙。

```
中国用户 ──► cloudphotos.top（新加坡 VM 20.195.27.151）
                  │
                  ├── /api/*  ──►  cloudphoto-api.azurewebsites.net
                  ├── /media/* ─►  photostorage.blob.core.windows.net/photos
                  └── /*      ──►  brave-sand-053b07a00.7.azurestaticapps.net
```

### 前提条件

1. Azure VM（Southeast Asia · Singapore）— Standard B2s，Ubuntu 24.04 LTS，SSH 公钥认证（`cloudphoto-vm-key.pem`）
2. 已购买域名（本项目使用 `cloudphotos.top`，阿里云注册）
3. 域名 DNS A 记录指向 VM 公网 IP

### DNS 配置（阿里云云解析）

当前权威 DNS（`dns23.hichina.com`，2026-08-11 实测）仅有 `cloudphotos.top` 与 `www.cloudphotos.top` 的 `A 20.195.27.151`；`cn.cloudphotos.top` 和 `global.cloudphotos.top` 均为 `NXDOMAIN`。下表是尚待 DNS 提供商实施的目标配置，不代表这些入口已经上线：

| 记录类型 | 主机记录 | 记录值 |
|---------|---------|--------|
| A | `@` | `20.195.27.151` |
| A | `cn` | `20.195.27.151` |
| CNAME | `global` | `brave-sand-053b07a00.7.azurestaticapps.net` |
| 智能 CNAME（中国大陆） | `www` | `cn.cloudphotos.top` |
| 智能 CNAME（境外） | `www` | `global.cloudphotos.top` |

> ⚠️ 需完成域名实名认证，否则 DNS 不生效（`.top` 等国际域名在阿里云均需实名）

### Azure NSG 入站规则

VM 所在网络安全组需开放：

| 端口 | 协议 | 说明 |
|------|------|------|
| 22 | TCP | SSH |
| 80 | TCP | HTTP（Let's Encrypt 验证 + HTTP→HTTPS 跳转） |
| 443 | TCP | HTTPS |

### 一键部署

```bash
# 1. 本地上传 infra 目录到 VM
scp -i /path/to/key.pem -r infra/ user@<VM_IP>:~/

# 2. SSH 进 VM
ssh -i /path/to/key.pem user@<VM_IP>

# 3. 安装 DNS 提供商对应的 Certbot 插件，再把插件参数传给安装脚本。
#    下列 PROVIDER/参数名是占位符，请按实际插件文档替换。
sudo bash ~/infra/setup.sh cloudphotos.top \
  --authenticator dns-PROVIDER \
  --dns-PROVIDER-credentials /root/certbot-dns.ini
```

`infra/setup.sh` 自动完成：
1. 系统更新
2. 安装 Nginx + Certbot
3. 部署 HTTP-only 临时配置，启动 Nginx
4. 通过调用者提供的 DNS-01 插件申请包含 `www` 的 Let's Encrypt SSL 证书
5. 部署完整反向代理配置（见 `infra/nginx.conf`）
6. 启用 systemd certbot.timer 自动续签（每日两次检查）

安装脚本会为裸域名、`www` 和 `cn` 同时申请证书 SAN。智能 DNS 会让 HTTP-01 随地区落到不同平台，因此脚本在进行系统修改前强制要求可自动续签的 DNS 插件参数，并拒绝 `--manual`。先按插件文档安装插件、创建权限仅限 DNS 验证的凭据文件，并将文件权限设为仅 root 可读；Certbot 会把插件配置保存在 renewal 配置中供 timer 后续续签。

### ⚠️ Nginx 配置变更必须手动部署到 VM

**Git 仓库里修改 `infra/nginx.conf` 不会自动应用到 VM，没有 Pipeline。**  
每次修改后，需要手动 SSH 部署：

```powershell
# 1. 上传最新配置
scp -i "C:\Users\zhangchi\Desktop\CloudPhoto\cloudphoto-vm-key.pem" `
    -o StrictHostKeyChecking=no `
    D:\Project\ProjectCode\MySource\CloudPhoto\infra\nginx.conf `
    azureuser@20.195.27.151:/tmp/nginx_latest.conf

# 2. 应用配置并重载
ssh -i "C:\Users\zhangchi\Desktop\CloudPhoto\cloudphoto-vm-key.pem" `
    -o StrictHostKeyChecking=no azureuser@20.195.27.151 `
    "sudo cp /tmp/nginx_latest.conf /etc/nginx/sites-available/cloudphoto && sudo nginx -t && sudo systemctl reload nginx && echo OK"
```

---

### Nginx 配置说明（`infra/nginx.conf`）

| Location | 代理目标 | 特殊配置 |
|----------|---------|---------|
| `/api/` | `cloudphoto-api.azurewebsites.net/api/` | `client_max_body_size 210m`，超时 600s（视频上传） |
| `/media/` | `photostorage.blob.core.windows.net/photos/` | 保留 `Range` / `If-Range` 与 206 响应；`private, max-age=3600, immutable` |
| `/` | `brave-sand-053b07a00.7.azurestaticapps.net` | 前端 HTML/静态资源反代；透传 SWA `Cache-Control` |

三个 location 均设置 `proxy_set_header Host <upstream-host>`（SNI 必须）和 `proxy_ssl_server_name on`。`/api` 与 `/media` 的 CORS allowlist 只包含 `cloudphotos.top` 受信子域和精确 SWA 源 `https://brave-sand-053b07a00.7.azurestaticapps.net`；禁止配置通配 `*.azurestaticapps.net`。受信 OPTIONS/GET 会回显相同 `Access-Control-Allow-Origin`，其他源不返回 ACAO。

`/healthz` 在新版 Nginx 中直接返回 `cloudphoto-proxy`。前端也部署一个 `cloudphoto-frontend` JSON 兜底；直达 SWA 时客户端继续使用 Azure API，旧 Nginx 反代该 fallback 时则通过同源响应的 Nginx `Server` 标识确认 `/api` 仍可用。生产 smoke 接受两个入口标识并继续独立检查 API。

前端缓存与全局响应头由 `packages/client/public/staticwebapp.config.json` 管理。该文件随 Vite 构建复制到 `dist` 根目录，SWA 对带内容哈希的 `/assets/*` 返回一年期 `immutable` 缓存；SPA shell、Service Worker、部署资产 manifest、稳定文件名图标和 `changelog.json` 保持重验证或短缓存。`navigationFallback` 必须排除 `/assets/*`，全局 404 rewrite 固定返回 `404.json` 并保留 404；`.js`/`.css` MIME 显式映射，缺失 hashed asset 不得伪装成 200/404 HTML。Nginx `/` location 未启用 `proxy_intercept_errors` 或本地 `try_files`，因此主域原样透传 SWA 的 404、JSON MIME 与正文。全局安全基线要求 `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`、`X-Frame-Options: SAMEORIGIN`、`Content-Security-Policy: frame-ancestors 'self'`、`X-Content-Type-Options: nosniff` 和 `Referrer-Policy: same-origin`，使 SWA 直连与 Nginx 主域都拒绝第三方页面嵌入；CSP 仅约束 framing，不限制脚本、图片、地图或 API 连接。`.webmanifest` 必须显式映射为 `application/manifest+json`，否则 SWA 会返回 `application/octet-stream`，在 `nosniff` 下无法可靠安装 PWA。manifest 固定使用根路径 `id`、`zh-CN` 语言以及 192/512 PNG 图标，另提供 512px maskable PNG；iOS 主屏幕入口使用独立 180px `apple-touch-icon.png`。构建契约会检查这些响应头、字段、用途、文件格式和实际像素尺寸；生产 smoke 要求 SWA 默认域名只返回 canonical HSTS，并要求 `cloudphotos.top` 的第一个 effective HSTS 为 canonical。Nginx 前端代理模板隐藏 SWA 的 HSTS、X-Content-Type-Options 与 X-Frame-Options 后再使用本地安全头，避免重复响应头；仓库变更不会自动热加载到 VM，必须按上文手动部署。未热加载期间首值已 canonical、尾部仍是旧本地值属于不阻断浏览器策略的 drift，但仍应手动部署模板以消除重复，且不得宣称 VM 已更新。不要在 Nginx 的 `/` location 重写 `Cache-Control`，否则会覆盖 SWA 的分层策略。

### 部署后更新 GitHub Secret

将 `VITE_API_BASE` 设为 Azure Functions 直连地址：
```
https://cloudphoto-api.azurewebsites.net/api
```

运行时行为：
- 在 `cloudphotos.top` 下，前端优先走同源 `/api`（VM Nginx 反代）
- 在 `cn.cloudphotos.top` 下同样优先走同源 `/api` 和 `/media`
- 在 `www.cloudphotos.top` 下先探测智能 DNS 落点：Nginx 响应使用同源 `/api`，直达 SWA 才使用 Azure Functions
- 若首选线路发生网络/网关失败，可安全重试的读取及认证请求自动回退；照片列表、动态视频、回收站和地理搜索等高成本读取不因短时慢响应自动重放，非幂等写请求也不重复发送
- 直接访问 Azure Static Web Apps 域名时，也使用该直连地址
- 媒体使用 Blob 与 `/media` 的无响应体 HEAD 竞速；Range 请求和 HEAD 探测不进入 PWA 媒体缓存

因此前端 CI 只需保持 `VITE_API_BASE` 指向 Azure Functions 直连地址，无需再把 secret 改成 `https://cloudphotos.top/api`。

### 前端生产发布边界

`.github/workflows/deploy-frontend.yml` 只有 `main` push，或在 `main` 上显式选择 `mode=production` 的 `workflow_dispatch`，才能暂存生产 artifact 并进入唯一的 `Deploy production` job。PR、`mode=validate` 和任何非 `main` 手动运行都只执行 build/contracts，既不暂存生产 artifact，也不会调用 `Azure/static-web-apps-deploy`。生产 job 通过 OIDC 登录 Azure 后即时解析 SWA deployment token，当前 workflow 不读取 repository 级生产 token。要同时阻断仍引用旧 token 的历史分支 workflow，必须删除并确认仓库不再配置旧 `AZURE_STATIC_WEB_APPS_API_TOKEN` secret。

所有 production run 共用 `deploy-frontend-production` concurrency group，且 `cancel-in-progress` 为 false：已经进入 Azure 的 upload 不会被后续 run 取消；GitHub 最多保留一个 pending run，同目标的更多事件会在进入 Azure 前 coalesce。这样 duplicate same-SHA 或快速连续 main push 不会并发竞争并制造 `Deployment Canceled` 红灯。PR 与其他 validation 按 PR 或 ref 使用独立、可取消旧验证的 group，不会干扰生产发布。

### 部署后健康检查

`.github/workflows/production-health.yml` 在前端或后端 workflow 完成后运行，并每 30 分钟定时检查一次。`workflow_run` 使用稳定的 workflow 文件路径识别前后端部署，不依赖会被自定义 `run-name` 覆盖的名称；并发分组、事件分类、SHA marker gate 和报告使用同一身份。该路径先在隔离的 controller checkout 中读取当前 canonical classifier；classifier 使用事件的 run ID 与 `run_attempt` 调用 attempt-specific jobs API，不能因重跑复用 run ID 而混合不同 attempt 的 conclusion 与 jobs。Frontend 只有该 attempt 的 `Deploy production` job 确实 started 才被视为部署，validation、build-before-deploy failure 和 Azure 前 coalesce 都不会伪造生产红灯。分类通过后，部署 SHA、报告文本和 `.deployment` checkout ref 均固定使用 `github.event.workflow_run.head_sha`，禁止以健康 workflow 的 `github.sha` 或已经前移的当前 `main` 代替实际部署版本。

网络检查前会从该 deployed revision 执行 workflow/runtime、production smoke 和安全头契约。`scripts/production-smoke.mjs` 同时验证 `cloudphotos.top` 与 Azure 直连前端/API 的首页 HTML、manifest MIME/身份/语言/PNG 安装字段、180px Apple Touch PNG、未登录认证状态和更新日志 JSON 契约，并检查主域 `/healthz`。两个入口还分别请求随机缺失的 hashed JS 与 CSS，必须收到 404 JSON 且正文不得是 HTML。每次前端 production build 还会写入只含 commit SHA 的 `deployment.json`；SWA 对它返回 `Cache-Control: no-store`，controller-owned identity smoke 使用 cache-busting query 要求主域与 SWA 直连 marker 都精确等于 triggering SHA。普通轮次并行执行 15 个检查，Frontend deployed-SHA full smoke 增加两条 marker 检查；结果按固定顺序输出，跨轮仍串行重试。

canonical Frontend、Frontend non-deployment、Backend 和定时/手动检查使用隔离的 concurrency group；较新的同类成功检查可以取代陈旧检查，但真实失败与 Frontend non-deployment 按 triggering run ID + attempt 隔离，不会被同一 run 的重跑或后续成功事件取消。按 10 秒请求超时、8 轮和 15 秒轮次间隔计算，最坏检查时长为 185 秒（不含 runner setup），低于 workflow 的 10 分钟上限。部署成功但传播尚未完成时，检查使用有限重试，不会用静态 changelog fallback 掩盖 API 错误。

本地先运行 `yarn test:production-smoke` 验证 fixture，再按需运行 `node scripts/production-smoke.mjs` 检查线上。

更新日志接口 `GET /api/changelogs?days=N` 默认返回最近 30 天；缺失、非整数、非正数均回退到 30，有效正整数最大限制为 365。

### SSL 证书维护

Certbot systemd timer 自动续签，证书到期前 30 天自动更新，无需手动操作。

查看续签状态：
```bash
systemctl status certbot.timer
```

---

## 方案对比

| | 直连 Azure | VM 反向代理 |
|--|-----------|------------|
| 访问域名 | `brave-sand-053b07a00.7.azurestaticapps.net` | `https://cloudphotos.top` |
| 中国大陆可用 | ❌ 不稳定 | ✅ 可用 |
| 额外成本 | 无 | Azure VM B2s + 域名 |
| SSL | Azure 托管 | Let's Encrypt（自动续签） |
| 上传大小限制 | Azure Functions 限制 | Nginx `client_max_body_size 210m` |
| 维护 | 全自动 | certbot 自动续签，Nginx 无需维护 |

两套方案可同时运行，互不影响。
