# CloudPhoto — 部署指南

本文档记录两套访问方案的架构与搭建流程。

---

## 方案一：直连 Azure（默认，国际访问）

| 组件 | URL |
|------|-----|
| 前端 | `https://brave-sand-053b07a00.7.azurestaticapps.net` |
| API | `https://cloudphoto-api.azurewebsites.net/api` |

### CI/CD 自动部署

- **前端**：推送 `packages/client/**` 变更时 `.github/workflows/deploy-frontend.yml` 自动触发，`VITE_API_BASE` 从 GitHub Secret 读取
- **后端**：推送 `packages/server/**` 变更时 `.github/workflows/deploy-backend.yml` 自动触发
- 两个 Workflow 均使用 **OIDC Federated Credential**，无任何长期密码

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

`/healthz` 在新版 Nginx 中直接返回 `cloudphoto-proxy`。前端也部署一个 `cloudphoto-frontend` JSON 兜底，因此尚未热重载 Nginx 的代理入口不会再把该路径回退为 SPA；客户端只把前者识别为同源 API 代理，生产 smoke 接受两个入口标识并继续独立检查 API。

前端缓存规则由 `packages/client/public/staticwebapp.config.json` 管理。该文件随 Vite 构建复制到 `dist` 根目录，SWA 对带内容哈希的 `/assets/*` 返回一年期 `immutable` 缓存；SPA shell、Service Worker、manifest、稳定文件名图标和 `changelog.json` 保持重验证或短缓存。不要在 Nginx 的 `/` location 重写 `Cache-Control`，否则会覆盖 SWA 的分层策略。

### 部署后更新 GitHub Secret

将 `VITE_API_BASE` 设为 Azure Functions 直连地址：
```
https://cloudphoto-api.azurewebsites.net/api
```

运行时行为：
- 在 `cloudphotos.top` 下，前端优先走同源 `/api`（VM Nginx 反代）
- 在 `cn.cloudphotos.top` 下同样优先走同源 `/api` 和 `/media`
- 若首选线路发生网络/网关失败，可安全重试的读取及认证请求自动回退；照片列表、动态视频、回收站和地理搜索等高成本读取不因短时慢响应自动重放，非幂等写请求也不重复发送
- 直接访问 Azure Static Web Apps 域名时，也使用该直连地址
- 媒体使用 Blob 与 `/media` 的无响应体 HEAD 竞速；Range 请求和 HEAD 探测不进入 PWA 媒体缓存

因此前端 CI 只需保持 `VITE_API_BASE` 指向 Azure Functions 直连地址，无需再把 secret 改成 `https://cloudphotos.top/api`。

### 部署后健康检查

`.github/workflows/production-health.yml` 在前端或后端部署完成后运行，并每 30 分钟定时检查一次。它通过 `scripts/production-smoke.mjs` 同时验证 `cloudphotos.top` 与 Azure 直连前端/API 的首页 HTML、未登录认证状态和更新日志 JSON 契约。同一轮 6 个检查并行执行，结果按固定检查顺序输出；跨轮仍串行重试。按 10 秒请求超时、8 轮和 15 秒轮次间隔计算，最坏检查时长为 185 秒（不含 runner setup），低于 workflow 的 10 分钟上限。触发它的部署失败时，健康 workflow 会显式失败；部署成功但传播尚未完成时，检查使用有限重试，不会用静态 changelog fallback 掩盖 API 错误。

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
