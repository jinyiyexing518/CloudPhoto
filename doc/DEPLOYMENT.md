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
中国用户 ──► cloudphotos.top（新加坡 VM 172.188.17.176）
                  │
                  ├── /api/*  ──►  cloudphoto-api.azurewebsites.net
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
| A | `www` | `20.195.27.151` |

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

# 3. 运行安装脚本（需 DNS 已生效：nslookup cloudphotos.top 8.8.8.8 返回 VM IP）
sudo bash ~/infra/setup.sh cloudphotos.top
```

`infra/setup.sh` 自动完成：
1. 系统更新
2. 安装 Nginx + Certbot
3. 部署 HTTP-only 临时配置，启动 Nginx
4. Let's Encrypt 申请 SSL 证书（`certonly --nginx`）
5. 部署完整反向代理配置（见 `infra/nginx.conf`）
6. 启用 systemd certbot.timer 自动续签（每日两次检查）

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
| `/` | `brave-sand-053b07a00.7.azurestaticapps.net` | WebSocket Upgrade 透传 |

两个 location 均设置 `proxy_set_header Host <upstream-host>`（SNI 必须）和 `proxy_ssl_server_name on`。

### 部署后更新 GitHub Secret

将 `VITE_API_BASE` 设为 Azure Functions 直连地址：
```
https://cloudphoto-api.azurewebsites.net/api
```

运行时行为：
- 在 `cloudphotos.top` 下，前端优先走同源 `/api`（VM Nginx 反代）
- 若 VM 代理发生网络级失败，前端自动回退到上面的 Azure Functions 直连地址
- 直接访问 Azure Static Web Apps 域名时，也使用该直连地址

因此前端 CI 只需保持 `VITE_API_BASE` 指向 Azure Functions 直连地址，无需再把 secret 改成 `https://cloudphotos.top/api`。

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
| 额外成本 | 无 | Azure VM B1s ~$7/月 + 域名 |
| SSL | Azure 托管 | Let's Encrypt（自动续签） |
| 上传大小限制 | Azure Functions 限制 | Nginx `client_max_body_size 210m` |
| 维护 | 全自动 | certbot 自动续签，Nginx 无需维护 |

两套方案可同时运行，互不影响。
