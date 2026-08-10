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
| 上传调度 | 网络感知加权队列 | 快网小图并发 3，视频最多与 1 图并行 |
| 上传背压 | Function 单实例/单用户准入 | 同时缓冲上限 256/220 MiB，繁忙返回 429 |

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
- 实现：打开全屏查看器时立即渲染已缓存的缩略图或现有 preview 占位（`position: absolute` 铺满），后台优先加载 2048px WebP 预览（~400KB），`onLoad` 后 0.25s fade-in 替换；`getViewerSrc()` 只在低像素视口复用 thumbnail，其余首次打开统一选 preview，原图由显式点击入口加载
- 效果：打开即有清晰缩略图，查看器实际传输量从 5–20MB 降至 ~400KB（节省 95%+）

---

### 流量优化

- **IntersectionObserver 无限滚动** — 首屏仅渲染 40 张，sentinel 节点触发分批加载；首屏流量减少 **66%**
- **2048px WebP 预览图** — 上传时服务端（sharp）同步生成 2048px WebP 预览；查看器加载预览而非原图，流量减少 **95%+**；缩略图和 EXIF 历史回填都按游标分批且单次最多读取一个 Blob 页，不把完整图库保留在 Function 内存，也不会在空/视频库中无界扫描
- **SAS 安全复用** — Workbox 仍以完整 SAS 查询作为私有缓存键；仅当同一资源的旧 URL 尚有 10 分钟以上有效期且不早于新 URL 过期时才复用，绝不以缓存命中换取更短可用期
- **自适应查看器 URL**（`getViewerSrc`）— `physicalPx = innerWidth × DPR × 0.85`；≤450px 优先 thumbnail，其余优先 preview；缺少 preview 时继续复用 thumbnail，只有没有任何派生图才回退 original
- **首屏封面优先级** — 时间线、重点片段和文件夹仅将前 6 张派生图标记为 `loading="eager"` + `fetchpriority="high"`，其余继续原生 lazy，避免首屏封面与屏外资源争抢连接
- **视频封面体积压缩** — `setVideoThumbnail` 端点用 sharp 将 canvas 截帧（最大 1920×1080，~500KB）缩至 400px 再存储，体积缩小 **10–15×**
- **视频按意图加载** — 网格只渲染持久化的 WebP 封面，不创建 video 元素；用户明确打开视频后才挂载 `preload="auto"` 播放器，由浏览器按 Range 获取起播数据
- **视频中途卡死自恢复** — 同源 `/media` 用 2-byte Range 严格验证 `206`，跨域 Blob 由媒体元素 no-CORS 播放能力验证；播放态连续 4 秒无进展才有限换线，即使 `readyState=4` 也不会掩盖停滞，并恢复原时间点、播放意图、音量、静音与倍速。direct 不尝试 tainted canvas 截帧，pause/seek/切后台不会误切，两条线路都失败时结束 loading 并提供原位重试
- **历史视频封面受控修复** — 无派生图、派生图线路全部失败，或 200/400px 派生图内容近乎纯白/纯灰的近视口卡片才在 idle 后进入全局队列；正常明亮但有纹理的画面不误判。同一 Blob 跨时间线/文件夹/故事只解码一次，未知网络并发 1、3G/4G 最多 2，saveData/离线/2G 为 0，并用 48 MiB 单文件、160 MiB 会话估算预算和最多 2 次带退避尝试阻止流量风暴。超过 48 MiB 的视频继续保持被动原文件请求为 0；用户主动播放后会复用现有 viewer，从非零时间点选择第一个非低信息、canvas 可读的已解码帧，只写一次 WebP。direct taint、第 0 帧和低信息帧均跳过且保持可重试，成功后 timeline/moments/folder 立即共用新封面
- **动图懒加载** — `loading="lazy"`，GIF/HEIC 接近视口才发请求
- **地理编码可靠代理** — `/api/geocode/search` 与鉴权 `/api/geocode/reverse` 共用合规 `User-Agent`、约 1 req/s 有界 admission、并发去重和 TTL/LRU 缓存；客户端按账号/空间隔离成功与短暂失败缓存，快速切图会取消旧地址请求，代理故障才直连一次

---

### 渲染优化

- **鉴权后加载图库** — `PhotoGallery` 及其批量操作、位置搜索等依赖拆为独立动态 chunk；未登录首屏入口从 179.82 kB 降至 120.83 kB（约 -33%，gzip 56.41 kB → 38.57 kB），登录成功后立即与照片请求并行预载
- **认证工作区整体分包** — `App.tsx` 只保留鉴权门与恢复 UI，2,200 行工作区迁入 `AuthenticatedApp.tsx`；入口进一步从 120.83 kB 降至 36.21 kB（约 -70%，gzip 12.82 kB，相对原始入口约 -80%），已有 token 与登录/注册提交都会提前并行下载
- **认证前样式分包** — 8,170 行工作区样式由 `AuthenticatedApp` 延迟加载，登录页仅保留完全一致的鉴权、会话恢复和 chunk 错误样式；首屏 CSS 从 128.56 kB 降至 9.38 kB（约 -93%，gzip 23.58 kB → 2.77 kB）
- **认证服务直接导入** — `AuthContext` 不再通过 `photoApi` 兼容 barrel 获取登录与 token API，照片线路、媒体 fallback 等工作区代码不再被 Rollup 提升到登录入口；入口由 36.25 kB 降至 30.45 kB（约 -16%，gzip 12.84 kB → 11.03 kB）
- **私有缓存生命周期分层** — `AuthContext` 只同步加载约 2 kB 的账号归属、generation 失效、在途写入 drain 与缓存删除逻辑；照片列表读写、裁剪和序列化留在认证后 chunk，入口由 30.45 kB 降至 28.84 kB（gzip 11.03 kB → 10.44 kB），且不削弱跨账号/角色缓存隔离
- **重要片段本地数据授权隔离** — moments 离线统计与诊断按用户、角色、个人/群组工作区派生键，并复用 owner/generation 与延迟写入围栏；注销、401、切号或降权在 UI 更新前同步清理私有照片、媒体和 moments，旧无归属全局键 fail closed 删除，应用壳与 app-code 保留
- **近期分享链接授权隔离** — 浏览器近期公开链接按用户+角色派生键；分享请求捕获 auth generation，注销/401/切号后的迟到响应写回为 **0**。旧全局键与损坏/超限 JSON fail closed 删除，云端托管分享和应用缓存不受影响
- **照片策略边界分层** — 账号 JWT 解析、通用 API 路由/hedge 与照片列表刷新、媒体缓存规则拆为独立模块；`http` 不再把 `:group:` 列表键等照片专用策略提升到登录入口，入口由 28.84 kB 降至 28.48 kB（gzip 10.44 kB → 10.31 kB）
- **注册表单按意图加载** — 默认登录页不再携带注册字段、校验和提交逻辑；注册 Tab hover/focus 预载同一个 lazy Promise，打开后保持表单状态并继续在提交前预载工作区。入口由 28.48 kB 降至 26.58 kB（gzip 10.31 kB → 9.91 kB），注册逻辑成为独立 2.79 kB chunk
- **更新弹窗 Idle 延后加载** — `WhatsNewPopup` 从 `AuthenticatedApp` 拆为独立 lazy chunk，照片列表 `loading=true` 时不挂载也不请求 changelog；`loading` 结束后仅在 `requestIdleCallback({ timeout: 2000 })`（含 `setTimeout` 兼容 fallback）空闲窗口挂载，且切回 loading/卸载会取消旧任务，避免迟到弹窗覆盖加载态。`AuthenticatedApp` 初始 chunk 从 95.43 kB 降至 92.59 kB（gzip 30.80 kB → 29.98 kB），并新增 `WhatsNewPopup-*.js` 3.81 kB chunk
- **最近更新完整模态键盘路径** — 打开后显式聚焦关闭按钮，Escape 关闭，Tab/Shift+Tab 基于每次按键时的可见控件动态循环；键盘聚焦/交互会 pin 弹窗并清空自动淡出计时器，关闭动画完成或组件卸载后仅向仍连接的原控件恢复焦点。更新摘要使用原生 `button` 与稳定 `aria-expanded`/`aria-controls` 关联
- **共享模态焦点与快捷键隔离** — Settings 与最近更新复用同一套动态焦点枚举、Tab 首尾循环和 connected-only 恢复能力；Settings 的 Escape 继续走维护/回收站 guard，普通键只阻断冒泡而不破坏输入、复制粘贴。全局快捷键额外拒绝 IME、已处理事件、交互目标、打开的 aria-modal 与重复刷新/Tab mutation
- **全局文件意图守卫** — 粘贴截图与桌面文件拖入通过纯策略复用快捷键的交互目标和 aria-modal 边界，并用同步 ref 读取最新完整传输状态；模态层后不上传、不显示拖入遮罩、不切换 Tab，受阻 drop 仍 preventDefault 防止本地文件覆盖应用
- **PWA 最小首装缓存** — Workbox 从预缓存全部 894.44 KiB 资源改为只安装 180.90 KiB 应用壳（约 -80%）；动态工作区 JS/CSS、注册表单与图库首次访问后进入 `app-code-v1` CacheFirst 缓存，兼顾首屏带宽与后续离线复用
- **Header 空间回收** — 已登录 Header 不再常驻 PWA 安装按钮，避免挤压群组切换、照片数量与用户菜单；安装能力继续保留在登录页、用户菜单和「设置 → 应用」
- **侧栏筛选容器级响应式** — 同一 `FilterBar` 以显式 sidebar variant 隔离抽屉布局，搜索/清空先行、快捷筛选与网格尺寸按容器自动换行；320–480px 与 200% 缩放下长标签和激活 chip 不再越界，所有交互保持至少 44px，宽桌面默认样式不变
- **PWA 安全更新闸门** — `onNeedRefresh` 仅设置全局 `update-ready` 状态并发事件，不自动 `updateSW(true)`/刷新页面；登录页期间收到更新事件也会在进入工作区后恢复更新提示
- **跨部署 chunk 一次性自愈** — pre-React 入口只识别同源 content-hashed JS/CSS 的 dynamic import/preload 失败，安全会话显式激活 waiting SW，再以 cache-busting 导航恢复，自动 reload 上限 **1 次**；危险操作期间 reload 为 **0**，完成后自动续接。时间线、文件夹、重要片段、地图、胶囊与故事各有 keyed ErrorBoundary，因此 FolderView 404 的故障域从整个主区缩至 **1 个 panel**；sessionStorage 只留 opaque 指纹和 allowlisted tab，生产 DOM 中 raw URL/stack 为 **0**。常驻恢复与 waiting-worker 控制令登录入口从 26.58 kB 增至 34.21 kB（gzip 9.91 → 12.76 kB），换取普通 Tab 与 installed PWA 的跨版本可恢复性
- **前端 production 单目标串行** — 事故中 1 个可观测 PushEvent 生成了同 SHA 的 2 个 attempt-1 Frontend runs（398/399），旧 workflow 无 concurrency，两个 SWA upload 竞速后留下 1 success + 1 Azure Deployment Canceled failure。现在 main push 与 main 手动 production 共用一个不取消在途 upload 的 production group；同目标最多 1 running + 1 pending，更多事件仅在 Azure 前 coalesce，SWA 并发 upload 上限固定为 **1**。PR 与 validation upload 为 **0**，当前 production job 通过 main OIDC 即时读取 SWA token且不引用 repository token；删除旧 secret 是让历史分支 workflow 同样失去凭据的运维前提
- **Production Health 稳定工作流身份** — workflow_run 使用不可被 `run-name` 覆盖的 workflow path 识别前后端部署；concurrency、classifier、SHA marker gate 和报告共享同一身份，手动 production 的自定义标题不再产生假红灯
- **胶囊与故事有界渲染** — 时光胶囊记忆区首批仅挂载 **18** 项、滚动或键盘到批次末项时追加 **12** 项且完整选择 Set 不丢失；自动故事只纳入图片和有安全派生封面的视频，并从逐项进度节点收敛为恒定 **1 个**原生 range scrubber，215+ 项时 DOM 规模仍有界，快速导航和卸载会清理 200ms 过渡任务
- **媒体类型零误请求** — `MediaThumb` 对 audio/* 只渲染本地图标与“音频”badge，网络媒体元素为 **0**；时光胶囊仍可选择音频，自动故事统一排除 audio、unknown 和无派生封面视频
- **胶囊存储防损坏边界** — 本地 key 按 user/workspace 隔离，legacy 只迁移 personal；100 胶囊 × 200 项、标题/名称长度、日期、重复 ID、URL/SAS 均经纯 normalization，读写或配额失败显式提示且 UI 只在持久化成功后更新
- **Service Worker 私有媒体缓存**
  - 问题：Azure SAS 令牌在 URL query string 中（`?sv=...&sig=...&se=...`），媒体缓存既要减少同一会话重复下载，也不能跨越账号授权边界
  - 大公司做法：CDN（Cloudflare / CloudFront）+ 稳定 content-addressed URL + `Cache-Control: immutable, max-age=31536000`  
  - 我们的方案：Workbox `CacheFirst` 保留 SAS 查询作为缓存键的一部分；只接收可验证的 `200 GET`，opaque、Range 和 HEAD 不进入缓存，避免把过期 SAS 的 403/状态 0 固化
  - 结构边界：600 条目 / 1 小时 / `purgeOnQuotaError`；注销、自动注销或切号清除私有 `photo-media-v1`，迟到写入也无法被其他账号的不同 SAS 请求命中
- **nginx 浏览器缓存头** — `Cache-Control: private, max-age=3600, immutable`，freshness 短于 2h SAS，不提供越过授权期的 stale window
- **HTTP Range Request 视频截帧**（`bandwidth.ts`）— 视频封面改为 `Range: bytes=0-524287`（512 KB）替代全量下载；iOS/Android 默认 faststart MP4 的 moov 原子在文件开头，512KB 足以解码元数据 + 截第一帧；非 `206` 响应主动取消响应体，避免忽略 Range 的线路继续传完整视频；首次访问 10 个视频：从 **1-2 GB → 5 MB**（-99.5%）
- **视频封面一次生成复用**（`bandwidth.ts`）— 新视频从本地 File 截帧与原文件上传并行，原 Blob 创建后立即持久化 400px WebP；播放历史视频时仍可补齐缺失封面，derivative 上传成功后以 ETag 条件合并 `thumbnailName`
- **原生浏览器下载，零 JS 文件缓冲** — 查看器空闲时预热按 auth generation 隔离、最多 8 条的附件 SAS；服务端用已校验的个人/群组 Blob 路径和安全文件名直接签票，不再读取 Blob metadata，点击路径不再串行 HEAD，大文件仍由浏览器原生传输
- **有界上传吞吐** — 4G 权重预算 3（3 图或视频 + 图片）、未知/3G 预算 2、`saveData`/2G 预算 1；相比旧严格串行，小图批次可测并发提升至 2–3×，暂停不打断在途 XHR
- **状态型上传重试** — XHR 暴露 status/Retry-After；只重试网络、408/425/429/5xx，指数 full jitter 上限 60 秒，413/422 等 4xx 不浪费三次请求
- **真实上传进度与结果** — succeeded 才按完整大小结算，failed/cancelled 保留实际 loaded；跨重试线传输单调累计供 EMA 使用。settle 后刷新图库期间继续保持离开守卫，最终通知统一报告成功/失败/取消，过期暂停状态不会遮住结果
- **单实例上传内存背压** — 正文前 Content-Length 快速 413/411/400，读取后真实长度与声明复核；每实例权重 3/256 MiB、每用户 3/220 MiB 的 lease 持有至派生图结束，用户状态归零清理。明确不是分布式限流，也不以 `host.json` 全站降并发替代端点级保护
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
| `priority.ts` | 照片重要性评分函数（收藏×120、标签×20、时效性 0-40）、`MOMENTS_MAX_PHOTOS` | `AuthenticatedApp.tsx` |
| `pagination.ts` | `DEFAULT_PAGE_SIZE = 24`、`SCROLL_SENTINEL_MARGIN = "200px"` | `PhotoGallery.tsx` |
| `render.ts` | preview-first 查看器选择、前 6 张封面优先级、`VIEWER_DPR_SCALE` | `photoApi.ts` / gallery surfaces |
| `media.ts` | `THUMBNAIL_MIME` 集合、`BLANK_GIF` 占位符、WebP 质量常量 | `PhotoCard.tsx` |

**设计原则**：纯函数 + 常量，无副作用，所有数值均有注释说明选取依据；新增优化算法时在此包统一沉淀，避免魔法数字散落各组件。

---

## 🔐 安全与鉴权

- **零密钥架构** — 存储与数据库全部通过 Azure Managed Identity（`DefaultAzureCredential`）访问，代码库无任何账户密钥
- **JWT 双令牌 + 并发刷新互斥锁** — 2h access + 30d rolling refresh；并发 401 时 Promise mutex 保证只发一次刷新；认证 generation + AbortController 防止旧刷新在注销/切号后恢复旧账号，迟到 401 也不能退出新账号
- **IP 滑动窗口限流** — 登录 10/分、注册 5/分、刷新 20/分；超限 `429 + Retry-After: 60`
- **OIDC 无密码 CI/CD** — GitHub Actions 通过 Azure Federated Credential 认证，无长期密码
- **用户委托 SAS** — Blob 访问凭证由 Managed Identity 签发（无账户密钥），2h 有效期，最小权限
- **文件夹重命名无覆盖事务** — 路径策略只接受规范相对路径与同 parent 末段改名，同时保留历史 Unicode source key；完整源/目标预检后，Azure Copy Blob 使用 destination `ifNoneMatch=*` 与 source ETag 原子拒绝竞态覆盖/旧版本搬移。copy/delete 各 4 路有界并发，rollback 仅 2 路；首个 copy 失败停止派发，已启动任务 settle 后统一回滚。copy 后复核 inventory，删除每个源前短租约锁住并验证目标 copyId + final ETag，源删除也受预检 ETag 保护；失败只清理仍可证明归属本操作的目标，保证每个媒体至少一份。根目录与递归文件夹卡片使用有名称的非交互 group 包裹独立原生打开按钮；空白、超长和 emoji 名称均生成完整可访问名称，重命名/删除作为至少 44×44 的独立兄弟 Tab stop，busy、拖放和焦点状态不会误触打开
- **照片卡片原生键盘与对比度** — timeline、moments、insight strip 与 folder grid 共用具名语义 group；主按钮支持打开/`aria-pressed` 选择，Shift+F10 菜单和 alertdialog 删除形成完整回焦链。文件名/日期/计数达到 **4.5:1**，操作图标、选择边界与 focus ring 达到 **3:1**，44×44 命中区、GIF、封面 repair 与拖放继续独立
- **重命名流量与 HTTP 边界** — 源/目标预检分别用最多 101/1 条的 Azure 分页，整批复用一次可取消的 delegation-key 请求；单次最多 100 个 Blob，超过时 mutation 前返回 413。copy phase 最长 120 秒并按 copyId 直接终止在途 Azure copy，rollback 最长 60 秒；60 秒目标租约内的源删除关键区限为 20 秒，服务端 210 秒总边界低于客户端 220 秒上限。限流错误完全交给 Azure SDK 的 Retry-After 与指数退避，应用层不再包一层重试，避免 429/503/ServerBusy 时形成重试风暴

---

## 🧠 智能与推荐

- **多维评分模型** — 收藏（×120）、主题完整度（×20）、时间衰减（40→0）、浏览热度（×24），前 20 张单独展示
- **跨设备浏览统计** — Cosmos DB 原子更新总量 / 用户分布 / 按日分布（`viewers` map + `dailyViews` map）
- **乐观 UI + 服务端合并** — 计数先客户端乐观更新，服务端响应后取 max，防并发回退
- **本地降级兜底** — 后端不可用时跨刷新保持本地计数，恢复后自动同步
- **历史上的今天** — 检测往年同月同日照片，按年份分组置顶
- **EXIF 智能提取与位置修复** — `exifr` 解析 GPS + 拍摄时间（naive datetime 防 UTC+8 偏差 8h）；GPS 保存在 Blob metadata，Cosmos 索引失败会显式提示，历史维护可不下载已有 GPS 原图直接幂等对账
- **新上传位置即时发布** — 空 MIME、octet-stream 与非标准 JPEG/HEIC 先用最多 64 字节签名/扩展名识别，客户端和 legacy 服务端各自具备 EXIF fallback；合法 GPS 写 Blob + Cosmos 后随上传响应合并到当前照片并刷新地图，地址失败明确显示“地址暂不可用”且不回显坐标

---

## 🎨 用户体验

- **多媒体全支持** — JPEG/PNG/HEIC/WebP/GIF/MP4/MOV/WebM（200MB）/语音备注/Android Motion Photo
- **触摸手势** — 双指捏合缩放 + 双击缩放 + 水平滑动切换，CSS transform
- **自动隐藏导航栏** — 下滚隐藏，上滚即恢复；Tab/Shift+Tab、方向键、Home/End 到达 Header 或页签时立即 reveal 并保持焦点矩形可见，导航聚焦、菜单/侧栏或模态层活跃期间不会再次隐藏
- **字节级上传进度** — `XHR.upload.onprogress` 驱动，显示 X.X / Y.Y MB
- **批量 mutation 执行边界** — 时间线、重要片段和文件夹按 source key + operation token 独立聚合；迟到 progress/finally 不能清理新操作，rename/time/location 串行隔离失败，移动最多 4 并发并把 reject/`false` 都计入失败
- **批量冲突入口互斥** — 同步 ref gate 阻止双击重入；mutation 期间原生 disabled 选择、全选、重命名、时间、位置、删除、移动确认和添加原图，位置搜索同步进入 saving 状态
- **长维护任务可控** — 缩略图与 EXIF 回填共用同步 operation gate 和 AbortController；每页完成即累计上报，用户停止、组件卸载、切号或空间漂移都不再继续分页，已完成页统计保留且旧 token 不能覆盖新任务
- **回收站 mutation 串行化** — 单张、全部和文件夹级恢复/永久删除共用同步 gate 与稳定快照 runner；单项失败继续处理，Abort 不计失败，停止后不启动下一项并重新加载远端状态
- **回收站不可逆操作保护** — 所有桌面、文件夹、卡片和移动端固定入口在任务期间真实 disabled；设置关闭、维护任务、空间漂移、卸载、Tab/群组切换、beforeunload 与 PWA 更新共用活动判定，停止状态保留部分完成/失败统计
- **更新与传输互斥** — 上传/下载/批量删除/回收站 mutation/语音备注录制或上传/批量 mutation/历史维护任务期间，PWA「立即更新」按钮禁用；同一全局守卫同步阻止切 Tab、切群组、beforeunload，并在横幅显示准确类型与累计进度
- **文件夹重命名 operation 边界** — operationId/workspaceId/token-safe reducer 与同步 ref gate 防双击和 stale finally；FolderCard 根层/递归层及批量、上传、移动、删除入口真实 disabled。空间漂移 AbortSignal 只停止客户端等待；成功、失败或超时均通过当前 workspace 的最新 callback 强制远端对账；横幅显示 `A → B` 而不虚构服务端百分比
- **PWA** — Service Worker + Manifest，可安装到桌面/手机
- **移动端布局源头治理** — 本周概况用共享 inline padding 变量维持 full-bleed，320/390px 根文档横向滚动归零而不禁用 Tab 自身横向滑动；≤360px FAB 默认收纳为 48px safe-area 入口，展开/收起具备键盘焦点与 ARIA 状态
- **PWA meta 生产契约** — 源码、dist 与线上 smoke 同时守卫标准 `mobile-web-app-capable=yes` 和 Apple 兼容 meta，消除 Chromium 弃用告警而不牺牲 iOS 安装能力
- **14 个键盘快捷键** + 快捷键速查表；交互控件与模态层具备背景快捷键安全边界
- **图标控件无障碍语义** — 关闭、清空、导航、播放、收藏与编辑按钮具备明确 ARIA 名称，状态型控件同步暴露 pressed 状态
- **六视图 WAI-ARIA 页签模型** — tablist/tab/tabpanel 以稳定 ID 关联并使用 roving tabindex；方向键循环激活、Home/End 首尾跳转，mutation/modal guard 拒绝时 selection 与焦点均不漂移，窄屏只做 nearest 横向滚动
- **动态跳到主要内容入口** — 首个键盘焦点可直接跳过 Header 与六视图页签并进入当前 active panel；目标随页签同步，焦点时才显示，侧栏/模态层打开时退出后台 Tab 序列，320/390px 与 200% zoom 根级横向溢出为 **0**
- **记忆地图完整键盘路径** — 22px 视觉标记保留地理锚点但交互命中区扩为 **44×44**；照片名语义、Tab/Enter/Space、详情/编辑 stacked modal、保存 pending 与 connected-only 回焦形成闭环。位置搜索使用真实 44px 按钮、方向键/Enter/Escape、polite live status 和 request/auth generation 围栏，清空、关闭、卸载或切空间后迟到结果为 **0 次覆盖**
- **Header 菜单与嵌套弹窗焦点链** — 空间切换和用户菜单统一支持方向键、Home/End、Escape、Tab 与 disabled skip；触发器获焦、菜单或子弹窗活跃时会 reveal 并锁定自动隐藏 Header。群组、安装、快捷键和管理员子弹窗共享 stacked modal boundary，pending 期间不可提前关闭且只向仍连接且可见的触发器恢复
- **侧栏 modal 与辅助技术隔离** — 关闭 drawer 保留过渡但以原生 inert + aria-hidden 从 Tab/辅助树移除；打开后聚焦关闭、动态循环 Tab、Escape/遮罩关闭并回到真实 FAB。设置等子层共享同一 modal stack，320/390px 与 200% zoom 仍在视口内

---

## ☁️ 云原生架构

- **Serverless** — Azure Functions v4 Consumption Plan，按请求计费
- **路径前缀多租户** — `personal/{userId}/` + `groups/{groupId}/`，单 Container 隔离多用户
- **邮件邀请** — 7 天有效链接，未接受前不加入群组
- **软删除 + 回收站** — `deletedAt` 标记，支持按原路径恢复
- **分离部署 Workflow** — 前后端独立 CI，按变更路径触发
- **部署 SHA 闭环验收** — Frontend artifact 写入只含 commit SHA 的 no-store marker；Production Health checkout triggering `head_sha`，并要求主域与 SWA 直连产物精确匹配，杜绝 main 前移后用未来脚本验证旧部署的假绿
- **新加坡 VM 反向代理** — Nginx + TCP BBR + HTTP/2，中国大陆直接访问，Let's Encrypt 自动续签

---

## 🛠️ 工程实践

- **TypeScript 全栈 strict mode** — 前后端共享类型，编译时捕获错误
- **monorepo（yarn workspaces）** — 统一 `yarn.lock`
- **Pre-push 变更日志强制** — git hook 要求每次推送附带 `changes/*.json`
- **`collect-changes.mjs`** — 自动生成 `changelog.json`，驱动前端 What's New 弹窗
- **前端服务层分域拆分** — `photoApi.ts` God File（899 行）拆为 `http.ts`（HTTP 工具）、`authApi.ts`（认证）、`uploadApi.ts`（上传）、`shareApi.ts`（分享）四个模块；`photoApi.ts` 保留为 barrel，零破坏性
- **后端按领域分层** — `utils/blob/`、`cosmos/`、`auth/`、`email/`
