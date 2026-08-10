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
- **2048px WebP 预览图** — 上传时服务端（sharp）同步生成 2048px WebP 预览；查看器加载预览而非原图，流量减少 **95%+**；缩略图和 EXIF 历史回填都按游标分批且单次最多读取一个 Blob 页，不把完整图库保留在 Function 内存，也不会在空/视频库中无界扫描
- **SAS 安全复用** — Workbox 仍以完整 SAS 查询作为私有缓存键；仅当同一资源的旧 URL 尚有 10 分钟以上有效期且不早于新 URL 过期时才复用，绝不以缓存命中换取更短可用期
- **自适应查看器 URL**（`getViewerSrc`）— `physicalPx = innerWidth × DPR × 0.85`；≤450px→thumbnail，≤2200px→preview，>2200px→original；手机避免加载多余像素
- **视频封面体积压缩** — `setVideoThumbnail` 端点用 sharp 将 canvas 截帧（最大 1920×1080，~500KB）缩至 400px 再存储，体积缩小 **10–15×**
- **视频按需加载** — `preload="none"` + IntersectionObserver，进入视口才调 `video.load()`；修复了 `useEffect` deps 遗漏 `useVideoThumb` 导致缩略图 404 后 Observer 永远不注册的 bug
- **动图懒加载** — `loading="lazy"`，GIF/HEIC 接近视口才发请求
- **地理编码服务端代理** — `/api/geocode/search` 携带合规 `User-Agent` 调用 Nominatim + 10 分钟内存缓存，解决国内直连 429

---

### 渲染优化

- **鉴权后加载图库** — `PhotoGallery` 及其批量操作、位置搜索等依赖拆为独立动态 chunk；未登录首屏入口从 179.82 kB 降至 120.83 kB（约 -33%，gzip 56.41 kB → 38.57 kB），登录成功后立即与照片请求并行预载
- **PWA 最小首装缓存** — Workbox 从预缓存全部 894.44 KiB 资源改为只安装 393.69 KiB 应用壳（约 -56%）；动态功能 chunk 首次访问后进入 `app-code-v1` CacheFirst 缓存，兼顾首屏带宽与后续离线复用
- **Service Worker 私有媒体缓存**
  - 问题：Azure SAS 令牌在 URL query string 中（`?sv=...&sig=...&se=...`），媒体缓存既要减少同一会话重复下载，也不能跨越账号授权边界
  - 大公司做法：CDN（Cloudflare / CloudFront）+ 稳定 content-addressed URL + `Cache-Control: immutable, max-age=31536000`  
  - 我们的方案：Workbox `CacheFirst` 保留 SAS 查询作为缓存键的一部分；只接收可验证的 `200 GET`，opaque、Range 和 HEAD 不进入缓存，避免把过期 SAS 的 403/状态 0 固化
  - 结构边界：600 条目 / 1 小时 / `purgeOnQuotaError`；注销、自动注销或切号清除私有 `photo-media-v1`，迟到写入也无法被其他账号的不同 SAS 请求命中
- **nginx 浏览器缓存头** — `Cache-Control: private, max-age=3600, immutable`，freshness 短于 2h SAS，不提供越过授权期的 stale window
- **HTTP Range Request 视频截帧**（`bandwidth.ts`）— 视频封面改为 `Range: bytes=0-524287`（512 KB）替代全量下载；iOS/Android 默认 faststart MP4 的 moov 原子在文件开头，512KB 足以解码元数据 + 截第一帧；非 `206` 响应主动取消响应体，避免忽略 Range 的线路继续传完整视频；首次访问 10 个视频：从 **1-2 GB → 5 MB**（-99.5%）
- **视频封面一次生成复用**（`bandwidth.ts`）— 首次 gallery 浏览时 canvas 截帧后自动 POST 到 `/api/photos/set-thumbnail`；derivative 上传成功后才以 ETag 条件合并 `thumbnailName`，session-level `Set` 防重复上传
- **原生浏览器下载，零 JS 文件缓冲**（`render.ts`）— 服务端返回带 `Content-Disposition: attachment` 的 SAS；客户端以有界 HEAD 换线预检后交给 `<a>` 下载，大文件不进入 JS heap
- **Tab 切换零重载** — 时间线常驻；重要片段和文件夹首次访问时才挂载，此后用 `display:none` 保持状态；Map/TimeCapsule/Story 等重型 Tab 仍按需加载
- **GIF 渐进式加载** — 服务端 sharp 为 GIF 生成静态首帧 WebP 缩略图；客户端先显示首帧，再通过共享的有限次直连/代理 fallback 预载完整动图
- **骨架屏** — 每张卡片渲染前展示闪光骨架，消除 CLS
- **防抖搜索** — 300ms 防抖，避免每次击键触发全列表重渲
- **useMemo 隔离大计算** — 时间线分组、片段评分、可见切片均按依赖变化重算
- **用户委托密钥缓存** — 有效期 > 10 分钟时复用，节省 Azure 控制面调用

---

## 🧮 Algorithm Package（`packages/algorithm`）

独立的纯 TypeScript 算法库，无 React/Azure 依赖，可被前端 bundle（Vite tree-shake）直接引用。

| 模块 | 核心内容 | 使用位置 |
|------|---------|---------|
| `bandwidth.ts` | Range Request 策略（`VIDEO_THUMB_RANGE_BYTES = 524 287`）、预加载边距 | `PhotoCard.tsx` |
| `priority.ts` | 照片重要性评分函数（收藏×120、标签×20、时效性 0-40）、`MOMENTS_MAX_PHOTOS` | `App.tsx` |
| `pagination.ts` | `DEFAULT_PAGE_SIZE = 24`、`SCROLL_SENTINEL_MARGIN = "200px"` | `PhotoGallery.tsx` |
| `render.ts` | 查看器图片分级阈值（thumb ≤ 450px / preview ≤ 2200px / original）、`VIEWER_DPR_SCALE` | `photoApi.ts` |
| `media.ts` | `THUMBNAIL_MIME` 集合、`BLANK_GIF` 占位符、WebP 质量常量 | `PhotoCard.tsx` |

**设计原则**：纯函数 + 常量，无副作用，所有数值均有注释说明选取依据；新增优化算法时在此包统一沉淀，避免魔法数字散落各组件。

---

## 🔐 安全与鉴权

- **零密钥架构** — 存储与数据库全部通过 Azure Managed Identity（`DefaultAzureCredential`）访问，代码库无任何账户密钥
- **JWT 双令牌 + 并发刷新互斥锁** — 2h access + 30d rolling refresh；并发 401 时 Promise mutex 保证只发一次刷新；认证 generation + AbortController 防止旧刷新在注销/切号后恢复旧账号，迟到 401 也不能退出新账号
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
- **图标控件无障碍语义** — 关闭、清空、导航、播放、收藏与编辑按钮具备明确 ARIA 名称，状态型控件同步暴露 pressed 状态

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
- **前端服务层分域拆分** — `photoApi.ts` God File（899 行）拆为 `http.ts`（HTTP 工具）、`authApi.ts`（认证）、`uploadApi.ts`（上传）、`shareApi.ts`（分享）四个模块；`photoApi.ts` 保留为 barrel，零破坏性
- **后端按领域分层** — `utils/blob/`、`cosmos/`、`auth/`、`email/`
