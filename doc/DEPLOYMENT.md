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
- **后端**：推送 `packages/server/**`、共享算法运行时代码，或后端发布/健康运行时代码变更时 `.github/workflows/deploy-backend.yml` 自动触发
- 部署与同步 Workflow 均使用 `actions/setup-node@v7`、基于 Node 24 的 `azure/login@v3` 和 **OIDC Federated Credential**，无任何长期密码；前端跨 job 产物固定使用 Node 24 的 `actions/upload-artifact@v7` / `actions/download-artifact@v8`，保持 `frontend-dist` 名称、`packages/client/dist` 路径和 1 天 retention 不变；静态契约会阻止 Node 环境 Action、登录 Action、artifact Action 或目标 Node 运行时回退到弃用版本
- 前端生产分支只由 `main` push 或 `main` 上显式 `workflow_dispatch mode=production` 的 workflow/job/step hard condition 选择；SWA Action 不传 `production_branch`，PR 与非 `main` 手动运行仍只验证且不会取得生产 artifact 或执行 Azure upload
- 前端 Vite 配置使用 `.mts` ESM 入口并从 `import.meta.url` 解析源码别名；构建后的静态契约会拒绝旧 `.ts` 配置或 CommonJS `__dirname` 回归
- 共享算法触发面严格限定为 `packages/algorithm/src/**`、`package.json` 和 `tsconfig.json`；README 等不会改变部署产物的文件不触发生产重建

### 跨部署静态资产保留

前端构建后、SWA upload 前执行 `scripts/deployment-assets.mjs`。脚本从 Azure 直连入口读取 `deployment-assets.json`，只接受 `assets/*-<hash>.js|css`，逐项验证字节数与 SHA-256 后复制到新 `dist`。代次 ID 由 commit SHA、GitHub run ID 和 attempt 组成，保证同一 commit 重跑时前一构建的精确 hash 仍按独立代次保留。当前代排在首位，最多保留 24 个完整代次和 64 MiB 唯一 JS/CSS；达到任一上限即从最旧完整代次开始淘汰，不保留 source map，也不允许路径碰撞、摘要漂移或无限累积。

`packages/client/deployment-retention.json` 是唯一策略源。`revokedGenerationIds` 使用 `deployment-assets.json` 中的精确代次 ID 做安全回滚：历史代次会立即排除，若当前发布代次自身被撤销则部署直接失败。首次上线时旧 SWA 会把缺失 manifest 伪装成 `200 text/html`；bootstrap 仅接受 policy 固定的响应状态、MIME、入口 HTML 骨架 SHA-256 且受 `expiresAt` 限时。骨架计算只归一化恰好一个 content-hashed `index-*.js` 与 `index-*.css` 名称，其余 HTML 字节必须一致；模板漂移、多入口、真 404、非法 UTF-8 或过期响应都拒绝部署，不能静默缩短兼容窗口。workflow 使用 `fetch-depth: 0` 保证 policy 固定的历史 commit 可达，复用本次 workflow 已安装的前端工具链执行 Vite 构建，并且只选取 `bootstrapGenerationAssets` 明列且精确 hash 文件名确实重建出的迁移资源；当前唯一条目是自然生成且与实证请求一致的 `AuthenticatedApp-BkGhvsE_.css`，不是旧 hash alias。受 build timestamp 影响的重建 JS 不进入 bootstrap；首轮之后历史 JS/CSS 都从线上读取原始字节。完成迁移后应删除 bootstrap source pin；若迁移资源发生安全撤销，则同时删除对应 bootstrap ref/assets/pin 并加入精确 revoked generation，禁止回建。

首轮发布还必须保护发布瞬间的当前生产代：通过上述已 pin HTML 提取入口 JS/CSS 和 modulepreload，再递归扫描其同源 hashed `.js`/`.css` 引用并下载原始字节。每个响应必须为 200 且保持 `text/javascript`/`application/javascript` 或 `text/css`，跨域、非 hash、source map、HTML fallback、空响应、非法 UTF-8、超过 512 个资源或超过 64 MiB 均拒绝发布。抓取代次与固定历史 CSS 都是首轮必需代次；若当前构建加两类 bootstrap 无法完整装入代数/字节预算，部署失败而不是淘汰其中一代。这样不只修复 2026-08-11 已受困 CSS，也不会在第一次启用 manifest 时删除当时生产 app shell 正在使用的 lazy JS/CSS。

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

三个 location 均设置 `proxy_set_header Host <upstream-host>`（SNI 必须）和 `proxy_ssl_server_name on`。`/api` 与 `/media` 的 CORS allowlist 只包含 `cloudphotos.top` 受信子域和精确 SWA 源 `https://brave-sand-053b07a00.7.azurestaticapps.net`；禁止配置通配 `*.azurestaticapps.net`。受信 OPTIONS/GET 会回显相同 `Access-Control-Allow-Origin`，其他源不返回 ACAO。Azure Functions 平台 CORS 由 Backend workflow 独立维护：每次 OIDC 发布幂等加入 `https://cloudphotos.top`、`https://www.cloudphotos.top` 与精确 SWA 源，回读缺失或出现 `*` 都在代码上传前失败；部署包 `host.json` 固定相同的非通配集合。

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
- 在 `www.cloudphotos.top` 下先探测智能 DNS 落点：Nginx 响应的登录和单次注册都使用同源 `/api`，直达 SWA 时两者使用已显式允许 `www` origin 的 Azure Functions
- 若首选线路发生网络/网关失败，可安全重试的读取及认证请求自动回退；照片列表、动态视频、回收站和地理搜索等高成本读取不因短时慢响应自动重放，非幂等写请求也不重复发送
- 直接访问 Azure Static Web Apps 域名时，也使用该直连地址
- 媒体使用 Blob 与 `/media` 的无响应体 HEAD 竞速；Range 请求和 HEAD 探测不进入 PWA 媒体缓存

因此前端 CI 只需保持 `VITE_API_BASE` 指向 Azure Functions 直连地址，无需再把 secret 改成 `https://cloudphotos.top/api`。

### 照片目录分页

- 无需新增 Azure 资源或环境变量。照片行、summary 和 mutation journal 复用现有 `Cosmos__Database` 下的 `photoLocations` 容器及 `/scope` partition key，并以 `photo-catalog`、`photo-catalog-summary`、`photo-catalog-mutation` 三种 `docType` 与位置索引隔离；跨实例权威 fence 复用现有媒体 Blob 容器，在内部 `_photo-catalog-fence/{sha256(scope)}.json` 路径按 ETag 条件读写，不能公开签名或纳入普通照片列表。Cosmos 容器需继续索引 `docType`、`snapshotId` 和 `sortKey`；不要为上线清空或重建容器。
- 首次发布必须分两阶段。第一阶段保持 `PHOTO_CATALOG_ROLLOUT_PHASE="writers-only"`：部署全部 fence-aware mutation writer，但 `limit/cursor` 返回 `photo-catalog-not-ready`，legacy 请求只扫描 Blob、不读取或建立 catalog；新客户端会自动回退完整数组。确认该 Backend exact SHA 健康后等待至少 10 分钟（mutation 恢复窗口），再以只修改 rollout phase 及对应契约的独立提交切换到 `enabled`。禁止在一个 deployment 中同时引入 writer fence 和 catalog publication；回滚必须先回到 `writers-only`，不能直接恢复会绕过 fence 的旧 writer。
- 每个 personal/group scope 的第一次兼容请求可能执行一次完整 Blob 扫描并原子 materialize 目录；每次 rebuild 将行写入唯一不可变 `snapshotId`，Cosmos summary 通过 ETag 原子切换 `activeSnapshotId`。之后 `limit` 请求只读同一 Cosmos partition 的 active snapshot，并仅为当前页签发 SAS。每次分页和 legacy 完整读取都必须先读 Blob ready fence、核对其 `snapshotId/revision` 与 summary 完全一致，并在 Cosmos 行查询后确认同一 fence ETag 未变；普通 Cosmos Session consistency 不能替代这两个检查。兼容读取、成功发布和每个 revision 的首 page 在同一 ready fence 下每次最多清理 250 条非 active catalog 行；只有返回不足 250 条时才在进程内记住该 revision 已清空，清理失败或正好达到上限则由后续首 page 继续。开始于查询期间的 mutation/rebuild 必须在删除前阻断清理。管理员无 `groupId` 的跨 personal-partition 视图暂时保留完整数组路径。
- 每个 Blob mutation 在实际媒体写入前必须把唯一 token 以 Blob ETag CAS 加入集合，后续每次 Blob 写前按 heartbeat 续租并验证 token 仍归当前 writer；失去 token 的暂停任务不得继续写。结束时先只移除自己的 token 且保持目录 invalid，再使 Cosmos summary unready 并清理 journal；并发 mutation 不能退化成 boolean 或单 token。重建必须先取得无活动 token 的 Blob rebuild owner，再执行 `listBlobsFlat`；扫描和分批写行期间同时续租 Cosmos summary ETag 与 Blob owner，失去任一 owner 即停止。批量 snapshot 写入首错后必须停止派发新行并等待全部在途 worker settle，之后才能 abandon 和删除该 snapshot，避免清理后迟到 upsert 复活旧行。写完隔离行后先以最新 rebuild ETag 条件发布 Blob ready marker，再以最新 Cosmos summary ETag 发布 summary。Cosmos 条件发布失败必须条件回滚自己的 ready marker；响应不确定时只在精确 read-back 证明 snapshot/revision 已发布后报告成功。迟到旧 rebuild 只能留下或清理自己的隔离 snapshot，不能覆盖新 snapshot 的同名行。成功切换后再清理先前 active snapshot，失败路径不得删除当前 active snapshot。活动写入或重建分别返回 `photo-catalog-mutating` / `photo-catalog-rebuilding`，客户端不能回退到可能半完成的 Blob 视图。
- 只有 mutation heartbeat 超过 10 分钟且 Blob token 可被 CAS 移除时，下一次完整兼容请求才能清理对应 orphan journal；只有 Cosmos 与 Blob rebuild heartbeat 超过 2 分钟时，旧 owner 才可被接管。近期 malformed/future Blob fence 必须 fail closed，仅在 Blob `lastModified` 证明超过恢复窗口后才允许条件重建；Cosmos owner 时间必须是 canonical ISO，且 owner 时间和服务端 `_ts` 均证明同一恢复窗已过，不能把宽松 `Date.parse` 结果直接当成过期证据。扫描必须用 `includeCopy` 取得 copy 状态，遇到 `copyStatus=pending` 的服务端 Blob copy 中止发布，`aborted`/`failed` 残留不得进入目录。单照片 move copy 使用 2 分钟 deadline、每次 poll 前续租、目标 `If-None-Match:*`、完整源 metadata 加内部 operation marker；begin response 丢失或 terminal residue 只按 marker/copyId/ETag 条件清理。copy 完成后取得 15 秒目标 lease 并复核 copyId/status/ETag，所有删源操作限定在 10 秒 critical section；删源返回已缺失表示后置条件已经满足，绝不能回滚唯一目标，源 ETag 冲突才删除仍属于本次且未变化的目标，外部改写目标则返回 recovery-required。任何 copy、poll、lease、abort 或 cleanup 都不得越过已失效 token。媒体操作已经返回明确成功时，catalog finish 错误只记录并保持目录 fail-closed，不能覆盖成功响应而诱发不可逆操作重试。反复出现同一 scope 的 busy response、每次分页都触发 Blob listing、Blob marker 与 Cosmos summary 不一致，或完成页唯一项数不等于 `total` 均视为发布阻断。位置查询必须继续使用数值 `lat/lon` 条件，防止共享容器中的 catalog 文档进入地图结果。
- 发布验证至少覆盖：`writers-only` 时 page fallback 且不建立 catalog、独立 activation commit、旧/新双向 API 兼容、24-item 首 page、opaque cursor 无重复/漏项、revision/snapshot 漂移重启一次、被取代 rebuild 的迟到写不改变 active page、多 mutation 乱序结束、旧 startedAt + 新 heartbeat 不被回收、writer/scan 失去 lease 后停止、跨实例 stale Cosmos summary、查询中 fence ETag 变化、pending copy 阻断、malformed/future/expired fence、ready-marker 条件回滚、非 active snapshot 有界续清、完整结果才写私有 cache，以及 cold load partial UI 不开放全图库消费者。完成后再通过一次个人 scope 和一个可授权群组 scope 的兼容请求建立生产目录；不得使用管理员跨 partition 结果冒充分页证据。
- `photoLocations` 与 catalog 文档共享容器，因此地图和列表 hydration 查询必须同时要求 `NOT IS_DEFINED(c.docType)` 与数值 `lat/lon`；否则同名 catalog 行会把合法位置误判为重复。cold-load 只读预览必须复用授权媒体线路回退，在 thumbnail 或首选线路失败后继续尝试 preview/备用线路，全部失败才显示本地占位。

### 后端生产发布边界

`.github/workflows/deploy-backend.yml` 只允许 `refs/heads/main` 进入 production jobs；非 main 手动运行使用独立、可取消的 validation concurrency，不能替换唯一的 production pending。main 发布按四个最小权限 job 串行执行：具备 scoped Actions write 的 preflight → 只有 contents read 的 build/package → 具备 scoped Actions write 的 final authorization → 唯一具备 `id-token: write` 的 deploy/receipt。前两次授权 checkout 完整历史并运行 `check-backend-deployment-target.mjs`：先刷新 `origin/main`，再确认 triggering SHA 仍是当前 main 的 ancestor，且其后没有任何 Backend artifact、根 `package.json`/`yarn.lock`、部署 workflow、Production Health 或相关运行脚本变更。后续仅有前端或文档 commit 时可继续；stale run 或 build 期间出现新的 Backend-relevant commit 时会失败并重新 dispatch 当前 main，避免 stale run 替换 pending 后留下无人发布的版本。仓库 build/test/package 脚本在 OIDC-capable job 之前完成，privileged job 只下载并复核本 run 的单一 artifact；复核时记录 SHA-256，Azure 登录完成后在 `config-zip` 同一步立即重算并匹配该 digest，防止验证与上传之间替换包。

上游 authorization 不是 deploy rerun 的可信前置条件：GitHub “重新运行失败的作业”会保留原 SHA/artifact，并跳过已经成功的 dependency jobs。为此 deploy job 自己另外 checkout 一个不持久化凭据的 full-history tree；在 Azure login 前和紧邻 upload 前分别运行无 `--requeue-current`、无 `GH_TOKEN` 的 target checker。两次只读 fence 都必须证明原 SHA 仍未被 Backend-relevant main commit 取代，覆盖 partial rerun 和 Azure 登录窗口竞态，同时不把 Actions write 与 OIDC 放入同一 job。失败时不上传；当前 main 的正常 push run 或 unprivileged authorization 负责自动 requeue，若操作员误重跑旧 attempt，则从当前 main dispatch，不得给 deploy 增加 requeue 权限。

Azure 登录成功后、最终 deploy-local target fence 前，workflow 使用 `az functionapp cors add` 幂等确保主域、`www` 与精确 SWA 默认域名都在 allowlist，并立即回读；任一必需 origin 缺失或存在 `*` 都硬失败。该平台配置步骤不携带 Actions write，随后仍必须通过最终 full-history fence 才能上传 zip，因此 main 在 CORS 校正期间出现 Backend-relevant 前移时不会发布旧 artifact。

生产依赖必须与测试依赖是同一个冻结图。build 先以根 `yarn.lock` 执行 frozen install 和 server tests；deploy-stage 只包含 server manifest，并复用同一 lock 与已填充的 Yarn cache 执行 offline、production-only frozen install。`check-backend-package-dependencies.mjs` 会遍历部署包的嵌套 `node_modules`，要求每个 `name@version` 都存在于刚测试的根图，且所有 server 直接依赖都已暂存。Linux runner 额外下载的 Windows `@img/sharp-win32-x64` tarball 必须通过同一 lock 中的精确 selector、version 和 SHA-512 integrity 后才可解包。任何无 lock 安装、registry 最新 caret 解析、缺依赖或版本漂移都是发布阻断。

构建包根目录必须包含 raw canonical `deployment.json`：`{"sha":"<lowercase-40-char-sha>"}`，只允许末尾单个换行；重复 `sha`、额外字段或替代格式一律拒绝。`az functionapp deployment source config-zip` 返回成功后，同一 job 立即以 `PRODUCTION_SMOKE_SCOPE=backend-deployment` 并发回读主域、`www` 与 Azure Functions 直连的 `/api/deployment`；三者都必须 200、且仅有 `Cache-Control: no-store`、无重定向且正文精确等于 triggering SHA，最多使用既有 8 轮/10 秒请求/15 秒间隔的传播预算。缺失、损坏、旧 SHA 或任一入口不可达都令 Backend workflow 失败，不能把 Azure CLI 接受 zip 当成 canonical receipt。

> GitHub 的 rerun 会使用原 run 对应提交中的历史 workflow 文件。本契约上线后的 run 即使只重跑 deploy，也受 deploy-local 双 fence 保护；但这些步骤无法追溯注入本次上线前已经存在的旧 workflow。不要重新运行旧版 Backend workflow。若旧 run 被误触发，Production Health 会因缺少 canonical receipt 或 marker 不匹配而失败，应立即从当前 `main` 手动 dispatch 新 workflow 恢复，而不能把旧 run 标记为成功。

### 前端生产发布边界

`.github/workflows/deploy-frontend.yml` 只有 `main` push，或在 `main` 上显式选择 `mode=production` 的 `workflow_dispatch`，才能暂存生产 artifact 并进入唯一的 `Deploy production` job。PR、`mode=validate` 和任何非 `main` 手动运行都只执行 build/contracts，既不暂存生产 artifact，也不会调用 `Azure/static-web-apps-deploy`。生产 job 通过 OIDC 登录 Azure 后即时解析 SWA deployment token，当前 workflow 不读取 repository 级生产 token。要同时阻断仍引用旧 token 的历史分支 workflow，必须删除并确认仓库不再配置旧 `AZURE_STATIC_WEB_APPS_API_TOKEN` secret。

Frontend workflow 对每次 `main` push 都创建 production 候选 run；即使后续提交只改文档或发布记录，也会成为替代候选。GitHub concurrency 最多保留一个 pending，旧 SHA rerun 可能替换当前 tip 候选；因此任一 ownership fence 返回 `stale-main` 时，production job 使用 scoped `actions: write` 的 `GITHUB_TOKEN` 重新 dispatch `main` + `mode=production`，由新候选重新竞争 pending，重复候选随后由 receipt gate 收敛。所有 production run 共用 `deploy-frontend-production` concurrency group，且 `cancel-in-progress` 为 false：已经进入 Azure 的 upload 不会被后续 run 取消。串行本身不等于幂等，因此 `Deploy production` 在 Azure 登录前、upload 前和 upload 完成后运行 `check-frontend-deployment-ownership.mjs`：触发 SHA 必须仍等于远端 `main` tip，并完整分页查询同 workflow、同 SHA全部 runs 的每个 attempt-specific jobs；只有 post-upload fence 仍持有 main-tip ownership 才记录 canonical receipt，upload 窗口内 main 前移则立即重排当前 tip 且 Health 不把该 attempt 当 canonical。若任一历史 attempt 已有 `Deploy to Azure Static Web Apps` + `Record canonical deployment receipt` 成功组合，还要以 cache-busting/no-store 请求确认 `cloudphotos.top` 与 SWA 直连 marker 当前都等于该 SHA，才把本次 upload 降为 0。历史 receipt 但线上 marker 已漂移时重新发布修复；marker 读取失败则 fail closed，不凭旧记录盲目跳过。旧 SHA、真正的 duplicate same-SHA 和 rerun 都只记录 coalesced notice，不会顺序重复发布，也不会取消在途 SWA upload。PR 与其他 validation 按 PR 或 ref 使用独立、可取消旧验证的 group，不会干扰生产发布。

### 部署后健康检查

`.github/workflows/production-health.yml` 在前端或后端 workflow 完成后运行，并每 30 分钟定时检查一次。`workflow_run` 使用稳定的 workflow 文件路径识别前后端部署，不依赖会被自定义 `run-name` 覆盖的名称；并发分组、事件分类、SHA marker gate 和报告使用同一身份。该路径先在隔离的 controller checkout 中读取当前 canonical classifier；classifier 使用事件的 run ID 与 `run_attempt` 调用 attempt-specific jobs API，不能因重跑复用 run ID 而混合不同 attempt 的 conclusion 与 jobs。Frontend 只有该 attempt 的 `Deploy to Azure Static Web Apps` step 实际 started，且紧随其后的 `Record canonical deployment receipt` 成功，才被视为 actual deployment；Backend 同样要求 `Deploy to Azure Functions` 与 `Record canonical backend deployment receipt` 都成功。validation、build-before-deploy failure、旧 Frontend SHA和重复 SHA的 coalesced success 都不会产生 actual Frontend health verdict；任一实际 upload 失败、receipt 缺失或身份非法必须 fail closed。分类通过后，部署 SHA、报告文本和 `.deployment` checkout ref 均固定使用 `github.event.workflow_run.head_sha`，禁止以健康 workflow 的 `github.sha` 或已经前移的当前 `main` 代替实际部署版本。

网络检查前会从该 deployed revision 执行 workflow/runtime、production smoke 和安全头契约。`scripts/production-smoke.mjs` 把权威 DNS 已部署的 `cloudphotos.top`、`www.cloudphotos.top` 与 Azure 直连作为独立 target：主域和 `www` 分别验证首页 HTML/安全头、`/healthz` 路由身份、未登录认证状态和更新日志 JSON；主域与 Azure 继续验证 manifest MIME/身份/语言/PNG 安装字段、180px Apple Touch PNG及随机缺失 hashed JS/CSS 的 404 JSON。认证可用性不再由 `/auth/me` 401 代替：主域以固定不存在账号执行无副作用登录，以空对象触发注册 validation；另模拟 `www`→Functions 和 SWA→主域代理的浏览器 JSON POST 预检，要求 exact ACAO 与 `Content-Type` allow-header。所有受检 URL 都禁用重定向，防止一个入口借用另一入口的成功响应。Frontend marker 由主域、`www` 与 SWA 直连回读；Backend marker 由主域 `/api/deployment`、`www` `/api/deployment` 与 Azure Functions 直连 `/api/deployment` 回读。普通轮次并行执行 23 个检查；Frontend 或 Backend deployed-SHA full smoke 各增加对应三条 marker，共 26 项，并各自再从 controller checkout 执行独立 3 项 marker-only identity gate。结果按固定顺序输出，跨轮仍串行重试。`cn` 与 `global` 在权威 DNS 仍为 NXDOMAIN 时不得加入健康 target 或被宣称已部署。

每个 Frontend workflow completion 都以 triggering run ID + attempt 隔离 Health concurrency；因此 duplicate/coalesced success 的快速跳过 run 不能取消 actual deployment 的 marker/full-smoke verdict。Backend 和定时/手动检查使用各自 group；真实失败也不会被后续成功事件隐藏。按 10 秒请求超时、8 轮和 15 秒轮次间隔计算，最坏检查时长为 185 秒（不含 runner setup），低于 workflow 的 10 分钟上限。部署成功但传播尚未完成时，检查使用有限重试，不会用静态 changelog fallback 掩盖 API 错误。

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
