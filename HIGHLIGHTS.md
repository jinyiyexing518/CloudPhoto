# CloudPhoto — 项目亮点

> 简历 / 面试速查版。按技术维度分类，每条附核心要点与可展开话题。

---

## 🚀 性能优化

### 跨境网络加速（中国大陆访问优化）

| 优化点 | 技术 | 效果 |
|---|---|---|
| 拥塞控制 | TCP BBR | 跨境吞吐提升 2–5× |
| 连接复用 | HTTP/2 多路复用 | 20+ 缩略图共用单条 TLS |
| 上游缓冲 | Nginx proxy_buffering | 解耦慢客户端与 Blob 连接 |
| 感知性能 | 渐进式预览加载 | 打开即见缩略图，0.25s 淡入 2048px 预览 |

**TCP BBR 详解**
- 背景：中国→境外线路存在 RTT 80–150ms、随机丢包 1–3% 的特性
- 问题：默认 TCP Cubic 把每次丢包误判为拥塞信号并将速率减半，形成持续速率震荡
- 方案：BBR（Google 2016）实时测量"最大带宽–最小 RTT"建立网络瓶颈模型，在带宽上限附近平稳发送，对随机丢包完全不敏感
- 部署：Linux 内核 `sysctl` 两行参数即可全局生效（`net.ipv4.tcp_congestion_control=bbr`）
- 效果：实测跨境吞吐提升 2–5×，原图预览从"极慢"到"接近 VPN 速度"

**HTTP/2 多路复用**
- 问题：HTTP/1.1 下 20 张缩略图 = 20 次 TLS 握手（每次 ~30–50ms RTT）
- 方案：Nginx `http2 on`，所有请求在单条 TLS 连接上并行传输
- 效果：画廊首屏加载延迟显著降低

**Nginx 代理缓冲**
- 问题：`proxy_buffering off` 时 Blob→Nginx→浏览器形成背压链路，Blob 连接速率受限于慢速客户端
- 方案：`proxy_buffering on`（32×256KB），Nginx 以 Azure 骨干网速率全速拉取，再按客户端速率转发
- 效果：Blob 连接更快释放，大文件传输效率提升

**渐进式预览加载**
- 实现：打开全屏查看器时立即渲染已缓存的缩略图占位（`position: absolute` 铺满），后台加载 2048px WebP 预览（~400KB），`onLoad` 后 0.25s fade-in 替换；`getViewerSrc()` 根据 `window.innerWidth × devicePixelRatio × 0.85` 自动在 thumbnail(400px) / preview(2048px) / original 三档选择，手机不加载原图
- 效果：打开即有清晰缩略图，查看器实际传输量从 5–20MB 降至 ~400KB（节省 95%+）

---

### 流量优化

- **IntersectionObserver 无限滚动** — 首屏仅渲染 40 张，sentinel 节点触发分批加载；首屏流量减少 **66%**
- **2048px WebP 预览图** — 上传时服务端（sharp）同步生成 2048px WebP 预览；查看器加载预览而非原图，流量减少 **95%+**；历史照片通过「回填」端点批量补生成
- **自适应查看器 URL**（`getViewerSrc`）— `physicalPx = innerWidth × DPR × 0.85`；≤450px→thumbnail，≤2200px→preview，>2200px→original；手机避免加载多余像素
- **视频封面体积压缩** — `setVideoThumbnail` 端点用 sharp 将 canvas 截帧（最大 1920×1080，~500KB）缩至 400px 再存储，体积缩小 **10–15×**
- **视频按需加载** — `preload="none"` + IntersectionObserver，进入视口才调 `video.load()`；修复了 `useEffect` deps 遗漏 `useVideoThumb` 导致缩略图 404 后 Observer 永远不注册的 bug
- **动图懒加载** — `loading="lazy"`，GIF/HEIC 接近视口才发请求
- **地理编码服务端代理** — `/api/geocode/search` 携带合规 `User-Agent` 调用 Nominatim + 10 分钟内存缓存，解决国内直连 429

---

### 渲染优化

- **Service Worker 媒体缓存**（SAS 令牌穿透缓存）  
  - 问题：Azure SAS 令牌在 URL query string 中（`?sv=...&sig=...&se=...`），每 2h 轮换 → URL 变化 → 浏览器缓存失效，每次访问重新下载全部图片（200 张 ≈ 90MB/次）  
  - 大公司做法：CDN（Cloudflare / CloudFront）+ 稳定 content-addressed URL + `Cache-Control: immutable, max-age=31536000`  
  - 我们的方案：Workbox `CacheFirst` + `matchOptions: { ignoreSearch: true }` — Service Worker 以路径为缓存键，忽略 SAS 参数；效果等同于个人 CDN  
  - 效果：重复访问 **0 字节**；600 条目 / 7 天 / `purgeOnQuotaError` 自动淘汰；SW 全模式注册（非 PWA 普通浏览器同样受益）
- **nginx 浏览器缓存头** — `Cache-Control: public, max-age=3600, stale-while-revalidate=7200`，覆盖 Azure Blob 默认 `no-cache`；无 SW 的浏览器在 SAS 有效期内命中 HTTP 缓存
- **骨架屏** — 每张卡片渲染前展示闪光骨架，消除 CLS
- **防抖搜索** — 300ms 防抖，避免每次击键触发全列表重渲
- **useMemo 隔离大计算** — 时间线分组、片段评分、可见切片均按依赖变化重算
- **用户委托密钥缓存** — 有效期 > 10 分钟时复用，节省 Azure 控制面调用

---

## 🔐 安全与鉴权

- **零密钥架构** — 存储与数据库全部通过 Azure Managed Identity（`DefaultAzureCredential`）访问，代码库无任何账户密钥
- **JWT 双令牌 + 并发刷新互斥锁** — 2h access + 30d rolling refresh；并发 401 时 Promise mutex 保证只发一次刷新，所有挂起请求共享新令牌自动重试
- **IP 滑动窗口限流** — 登录 10/分、注册 5/分、刷新 20/分；超限 `429 + Retry-After: 60`
- **OIDC 无密码 CI/CD** — GitHub Actions 通过 Azure Federated Credential 认证，无长期密码
- **用户委托 SAS** — Blob 访问凭证由 Managed Identity 签发（无账户密钥），2h 有效期，最小权限

---

## 🧠 智能与推荐

- **多维评分模型** — 收藏（×120）、主题完整度（×20）、时间衰减（40→0）、浏览热度（×24），前 20 张单独展示
- **跨设备浏览统计** — Cosmos DB 原子更新总量 / 用户分布 / 按日分布（`viewers` map + `dailyViews` map）
- **乐观 UI + 服务端合并** — 计数先客户端乐观更新，服务端响应后取 max，防并发回退
- **本地降级兜底** — 后端不可用时跨刷新保持本地计数，恢复后自动同步
- **历史上的今天** — 检测往年同月同日照片，按年份分组置顶
- **EXIF 智能提取** — `exifr` 解析 GPS + 拍摄时间（naive datetime 防 UTC+8 偏差 8h）

---

## 🎨 用户体验

- **多媒体全支持** — JPEG/PNG/HEIC/WebP/GIF/MP4/MOV/WebM（200MB）/语音备注/Android Motion Photo
- **触摸手势** — 双指捏合缩放 + 双击缩放 + 水平滑动切换，CSS transform
- **自动隐藏导航栏** — 下滚隐藏，上滚即恢复，300ms cubic-bezier
- **字节级上传进度** — `XHR.upload.onprogress` 驱动，显示 X.X / Y.Y MB
- **批量操作** — 多选批量删除/移动/改时间/改 GPS，`Promise.all` 并发
- **传输守卫** — 上传/下载中阻止 Tab 关闭，`beforeunload` 拦截
- **PWA** — Service Worker + Manifest，可安装到桌面/手机
- **14 个键盘快捷键** + 快捷键速查表

---

## ☁️ 云原生架构

- **Serverless** — Azure Functions v4 Consumption Plan，按请求计费
- **路径前缀多租户** — `personal/{userId}/` + `groups/{groupId}/`，单 Container 隔离多用户
- **邮件邀请** — 7 天有效链接，未接受前不加入群组
- **软删除 + 回收站** — `deletedAt` 标记，支持按原路径恢复
- **分离部署 Workflow** — 前后端独立 CI，按变更路径触发
- **新加坡 VM 反向代理** — Nginx + TCP BBR + HTTP/2，中国大陆直接访问，Let's Encrypt 自动续签

---

## 🛠️ 工程实践

- **TypeScript 全栈 strict mode** — 前后端共享类型，编译时捕获错误
- **monorepo（yarn workspaces）** — 统一 `yarn.lock`
- **Pre-push 变更日志强制** — git hook 要求每次推送附带 `changes/*.json`
- **`collect-changes.mjs`** — 自动生成 `changelog.json`，驱动前端 What's New 弹窗
- **后端按领域分层** — `utils/blob/`、`cosmos/`、`auth/`、`email/`
