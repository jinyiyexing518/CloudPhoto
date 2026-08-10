# CloudPhoto — 全栈私有云相册系统

> 一款生产级全栈私有云相册，基于 **React 18 + Azure Functions v4 + Azure Blob Storage + Cosmos DB** 独立设计与实现，具备完整的用户认证、群组共享、多媒体管理、智能推荐与渐进式性能优化体系，累计实现 **85+ 功能迭代**，全程使用 GitHub Actions + OIDC 自动化部署至 Azure。

**用户手册：** [USER_GUIDE.md](doc/USER_GUIDE.md)

| 层 | 技术栈 | 托管 |
|---|---|---|
| 前端 | React 18 · TypeScript 5 · Vite 5 · CSS Modules | Azure Static Web Apps |
| 后端 | Azure Functions v4 · Node.js 24 · TypeScript | Azure Functions (Consumption) |
| 算法库 | `@cloudphoto/algorithm` — 带宽 / 渲染 / 分页 / 优先级算法（纯 TS，无平台依赖）| monorepo 内部包 |
| 存储 | Azure Blob Storage（用户委托 SAS，无账户密钥） | East Asia |
| 数据库 | Azure Cosmos DB NoSQL（托管身份，无连接字符串） | East Asia |
| 反向代理 | Nginx 1.24 · HTTP/2 · Let's Encrypt SSL · TCP BBR 拥塞控制（中国大陆入口） | Azure VM B2s · Southeast Asia |
| CI/CD | GitHub Actions · Node 24 · OIDC 无密码部署 | GitHub |

---

## 架构

### 直连模式（国际访问）

```text
brave-sand-053b07a00.7.azurestaticapps.net   ← Azure Static Web Apps（前端）
        │
        │  HTTPS + CORS
        ▼
cloudphoto-api.azurewebsites.net/api/*       ← Azure Functions v4（后端）
        │
        ├── Azure Cosmos DB NoSQL (cloudphoto)
        │       ├── users      (分区键: /id)
        │       ├── admins     (分区键: /id)
        │       ├── groups     (分区键: /id)
        │       ├── invites    (分区键: /id)
        │       ├── sharelinks (分区键: /id)
        │       ├── changelogs (分区键: /id)
        │       └── moments    (分区键: /id)
        │
        └── Azure Blob Storage (photostorage / photos)
                └── 时效用户委托 SAS（2小时，无密钥）
```

### VM 反向代理模式（中国大陆访问）

```text
用户浏览器
    │
    │  https://cloudphotos.top
    ▼
cloudphotos.top  ← Azure VM · Southeast Asia（当前 A 记录：20.195.27.151）
Nginx 反向代理  ← Let's Encrypt SSL · 自动续签
    │
    ├── /api/*  ──►  cloudphoto-api.azurewebsites.net/api/*
    ├── /media/* ─►  photostorage.blob.core.windows.net/photos/*
    │
    └── /*      ──►  brave-sand-053b07a00.7.azurestaticapps.net
```

`azurewebsites.net` 和 `azurestaticapps.net` 在中国大陆访问不稳定；VM 作为境外中转，所有请求统一走 `cloudphotos.top`，用户无需翻墙。

详细部署步骤见 [DEPLOYMENT.md](doc/DEPLOYMENT.md)。

本地开发时，Vite 将所有 `/api/*` 请求代理到 `localhost:7071`。生产环境当前已部署的 `cloudphotos.top` 与 `www.cloudphotos.top` 都解析到 Nginx，优先走同源 `/api`；SWA 默认域名直达 Azure Functions。`cn.cloudphotos.top`、`global.cloudphotos.top` 与 `www` 智能 DNS 分流仍是规划配置，启用前不能作为可用入口。只读请求和登录/刷新等可安全重试的请求在线路网络或网关故障时双向回退；照片列表、动态视频、回收站和地理搜索等高成本读取不会仅因 5 秒内未返回响应头就向同一后端重放。非幂等写请求不会在发送后自动重放，避免重复上传或修改。

上传使用网络感知的加权并发：4G/快网预算 3，未知网络或 3G 预算 2，`saveData`/2G 预算 1；图片权重 1，视频或大文件权重 2，因此快网最多同时 3 张图片或 1 个视频 + 1 张图片，未知网络仍可并发 2 张小图。暂停只冻结新任务，已开始的 XHR 继续完成；批次进度只把成功文件计为完整大小，进行中、失败和取消项保留真实已上传字节。重试及线路回退的实际线传输单调累计并单独用于速度采样，不会把进度重置误算为负速度或把失败补成整文件。仅网络错误、超时、408/425/429/5xx 使用稳定 `uploadId` 重试，并遵守 `Retry-After` 与 60 秒上限的指数 full jitter；其余 4xx 立即显式失败。批次结束会在刷新照片库期间保留传输守卫，并明确显示成功、失败和取消数量；旧暂停状态不会覆盖 settled 结果，最终通知始终同时报告成功与失败数，并在存在时报告取消数。

新上传照片的位置链路不依赖浏览器 MIME 完整性：空 MIME、`application/octet-stream` 和 JPEG/HEIC 非标准 MIME 会通过最多 64 字节文件头及扩展名识别，客户端 `exifr` 与服务端 legacy upload 都能独立恢复 GPS。客户端坐标必须成对、finite 且在纬度 ±90°/经度 ±180° 内，否则服务端回退读取原文件 EXIF；最终坐标写入 Blob metadata、同步 Cosmos 并随上传响应返回。同名缓存照片会采用最新 GPS、拍摄时间、SAS 与派生图，记忆地图随上传显式刷新。时间线计数、无位置筛选和地图共用同一有限坐标对分类；单边、NaN、Infinity、越界与缺失值只能进入无位置分区，用户可见的有/无位置集合互斥且总数闭合。地图只采用当前照片与合法 Cosmos 索引的交集，旧交集与孤儿索引不会生成标记；位置编辑按当前 workspace 与照片名重新解析目标，目标离开当前照片分区时会中止等待中的 PATCH 并安全关闭。反向地理编码失败显示“地址暂不可用”，不会被误报为无 GPS，也不会在状态文案中回显坐标。

服务端在读取正文前检查 `Content-Length`，声明超限直接返回 413，缺失返回 411、非法返回 400；`arrayBuffer()` 后再次验证真实长度不超限且与声明一致。每个 Function 实例使用总权重 3、总声明字节 256 MiB，每用户权重 3、声明字节 220 MiB 的进程内准入，超限返回 `429 + Retry-After: 3`，lease 覆盖 Blob 写入及图片派生图生成并在 `finally` 释放。该限制明确只保护单实例内存，不是分布式限流；没有修改 `host.json` 的全站 HTTP concurrency，避免无证据地压低登录、列表和下载票据等轻请求吞吐。原文件下载继续由浏览器使用附件 SAS 直连 Blob，不经过 Functions 正文转发。

媒体也使用双线路：派生图继续用无响应体的 `HEAD` 在 Blob 直连和 `/media` 代理中选择线路；视频打开时只对浏览器可读的 `/media` 代理发送 `Range: bytes=0-1`，仅接受 `206` 并立即取消响应体，代理返回 `200`、失败或超时则让媒体元素直接尝试 Blob，避免用一个必然被存储 CORS 拒绝的 browser fetch 误判直连。播放中的 `waiting` / `stalled` 只有在可见、未暂停、未 seek、未结束且 4 秒没有时间进展时才切换一次线路；`readyState=4` 也不能覆盖真实的时间轴停滞。新线路在 metadata 恢复后还原位置、播放意图、静音、音量和倍速。跨域 Blob 播放不强制 CORS 模式，也不尝试可能污染 canvas 的 playback thumbnail capture；同源代理仍可安全执行封面截帧。两条线路耗尽后明确显示失败与重试，不会永久转圈或在直连/代理间循环；所有代理探测的非 `206` Range 响应都会主动取消响应体，避免忽略 Range 的线路继续下载完整视频。低信息或失效派生图会按登录代次与完整 workspace Blob 名进入内存 registry；即使 93 MB 大视频因 48 MiB 被动修复上限而不自动下载，用户主动播放后也会复用同一个已解码 viewer，在 `playing/timeupdate` 的非零时间点评分第一个有效画面并只持久化一次。第 0 帧、纯白/纯灰帧和 direct CORS-tainted 帧不会上传或消耗后续代理线路的修复机会，也不会创建第二个 video 或额外下载原文件。

照片列表使用按 `userId + role + groupId` 隔离的一小时 SWR 缓存：冷启动只发起一次列表请求；刷新页面时可先绘制最近的非空列表，再后台刷新，刷新失败仍显示错误提示。内存和 Cache Storage 各最多保留 24 个列表，过期项会清除。PWA 仅缓存可验证的 `200 GET` 媒体响应，Range/HEAD 和跨域 opaque 响应绕过缓存；媒体缓存保留 SAS 查询作为授权边界并限制为一小时，避免注销竞态中的迟到写入被其他账号复用。重要片段的离线浏览统计和诊断按 `userId + role + groupId` 派生本地键，浏览器内的近期公开分享链接按 `userId + role` 派生本地键；所有私有本地 JSON 都执行结构、大小和条目上限校验。注销、401、无效会话恢复、角色变化或账号切换会在认证 UI 更新前同步失效内存并删除照片列表、私有媒体、重要片段数据和近期分享链接；同时定向清除 Workbox expiration 数据库中仅属于私有照片缓存的元数据，并在活动写入结束后重复执行以阻止迟到记录复活。应用壳/precache、`app-code-v1` 的 Cache Storage 与 expiration 元数据以及 service worker 注册均保持不变；数据库或对象仓库不存在时也不会创建、升级或整库删除。

旧版全局 `cloudphoto_moments_*_v1` 和 `cf_recent_share_links` 数据没有可信账号归属，首次会话准备或退出页刷新时会直接删除而不会自动迁移给当前账号；只留下不含照片名、账号、诊断正文或公开分享 token 的清理标记。所有延迟写入都携带授权 owner + generation，分享请求在联网前固定 generation，退出或切号后返回的旧响应无法重建旧全局键或已失效范围的数据。云端托管分享仍由服务端管理；网格大小、FAB 位置、安装提示和按工作区限定的文件夹路径不属于这次私有数据清理范围。

Blob 与 Nginx `/media` 的浏览器缓存均为 `private, max-age=3600, immutable`，短于 2 小时 SAS；Nginx CORS 仅回显 `cloudphotos.top` 受信域和实际 SWA 源 `https://brave-sand-053b07a00.7.azurestaticapps.net`，不会接受任意 `*.azurestaticapps.net`。

SWA 与 Nginx 模板统一使用 `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`。静态契约强制两端配置统一；生产 smoke 要求 SWA 直连值唯一且严格 canonical，并要求 Nginx 入口的第一个 effective HSTS 严格 canonical。Nginx 前端代理模板隐藏 SWA 上游的 HSTS、X-Content-Type-Options 与 X-Frame-Options，再由本地统一发出。仓库中的 Nginx 模板不会自动热加载到 VM，必须按部署文档手动应用后，线上尾部旧值与重复头才会消失；发布期间首值已 canonical 但尾部仍有旧本地值属于不阻断浏览器策略的基础设施 drift，不能宣称已完成 VM 热加载。

### 全球与中国大陆入口

#### 当前已部署（2026-08-11 权威 DNS 实测）

| 主机名 | 当前权威解析 | 状态 |
|---|---|---|
| `cloudphotos.top` | `A 20.195.27.151` | Nginx 生产入口 |
| `www.cloudphotos.top` | `A 20.195.27.151` | Nginx 生产入口 |
| `cn.cloudphotos.top` | `NXDOMAIN` | 未部署 |
| `global.cloudphotos.top` | `NXDOMAIN` | 未部署 |

以上结果来自权威服务器 `dns23.hichina.com`。生产 smoke 只检查实际可用的 `cloudphotos.top` 与 SWA 默认域名，不宣称 `cn`、`global` 或智能 DNS 已上线。

#### 规划 / 需 DNS 提供商配置

客户端回退只能处理 API/媒体故障；如果 HTML 入口本身在某个地区不可达，必须在 DNS 层分流。以下仅为规划记录，需先在 SWA/Nginx 配置对应自定义域名和证书，再由 DNS 提供商实施：

| 主机名 | DNS 记录 | 用途 |
|---|---|---|
| `cn.cloudphotos.top` | `A 20.195.27.151` | 大陆/受限网络备用入口 |
| `global.cloudphotos.top` | `CNAME brave-sand-053b07a00.7.azurestaticapps.net` | 海外直连入口 |
| `www.cloudphotos.top`（中国大陆线路） | `CNAME cn.cloudphotos.top` | 智能 DNS 大陆解析 |
| `www.cloudphotos.top`（境外线路） | `CNAME global.cloudphotos.top` | 智能 DNS 境外解析 |

`infra/nginx.conf` 提供不落入 SPA 的 `/healthz`，返回 `cloudphoto-proxy` 供未来智能 DNS 与客户端识别；SWA 同一路径提供 `cloudphoto-frontend` JSON 兜底。旧 Nginx 尚未热重载时可能把该 frontend JSON 继续反代给 `www`，客户端会同时检查同源响应的 Nginx `Server` 标识，避免把仍可用的 `/api` 错判为跨域直连。定时线上 smoke 会校验入口标识并分别检查两套 API。`www` 同时落到两个平台时必须使用可自动续签的 DNS-01 插件签发证书，避免 HTTP-01 校验被地域解析到另一端；`infra/setup.sh` 会拒绝缺少 DNS 插件参数或不可续签的 `--manual` 模式。裸域名 `cloudphotos.top` 可继续作为稳定的代理兜底入口。

---

## 功能列表

- **JWT 认证与自动刷新** — 2 小时访问令牌 + 30 天滚动刷新令牌；收到 401 时客户端静默刷新并重试原请求；并发 401 共享同一个刷新请求（互斥锁），注销/切号会中止并作废旧会话刷新，迟到的 401 不会退出新账号
- **API 双向故障回退** — 大陆入口优先同源 `/api`，全球入口优先 Azure Functions；读取请求在网络或网关故障时切换线路，高成本读取仅在明确失败后换线，非幂等认证与写入请求不重复发送
- **媒体自适应线路** — 图片用轻量 `HEAD` 选择 Blob 直连或 Nginx `/media`；视频用 2-byte Range/206 探测，并在真实播放停滞 4 秒后有限换线、原位恢复，双线路失败时提供明确重试
- **媒体首显快路径** — 首屏前 6 张派生图使用 eager/high priority，其余继续 lazy；线路探测结果会刷新已渲染卡片，查看器首次只选 400px 缩略图或 2048px 预览，原图仅在显式预览时获取
- **历史视频封面自修复** — 仅接近视口且缺少、加载失败或内容近乎纯白/纯灰的派生图在浏览器空闲时进入全局去重队列；未知网络并发 1、明确快速网络最多 2，省流量/离线/2G 自动暂停，并受 48 MiB 单文件与 160 MiB 会话估算预算约束。修复会在视频稍后位置采样多个候选帧、选择信息量最高的画面，再复用既有 ETag 持久化端点。超过被动上限的视频仍可在用户主动播放、已有同源代理帧解码后修复，不创建第二个媒体元素，不上传低信息帧；成功 URL 立即同步时间线、重要片段与文件夹
- **下载票据预热** — 打开查看器后预取最多 8 个、按登录代次隔离的附件 SAS；点击下载不再串行等待 Blob metadata 与媒体 HEAD，仍由浏览器原生传输原文件
- **用户隔离照片 SWR** — 最近非空照片列表按用户/群组持久化并限量保留；刷新先本地绘制再联网，注销/切号清除列表与私有媒体缓存
- **认证限流** — 内存中按 IP 滑动窗口：登录 10 次/分，注册 5 次/分，刷新 20 次/分；超限返回 `429 + Retry-After: 60`
- **委托密钥缓存** — Azure 用户委托密钥进程内缓存，有效期剩余 > 10 分钟时复用，省去每次列表请求的一次控制面调用
- **角色系统** — 全局 `admin` / `viewer`；群组内 `admin` / `member`
- **个人私有空间** — 个人文件夹仅对本人可见（管理员可看全部）
- **群组共享** — 创建群组并通过用户名或邮箱邀请成员；所有加入均通过邮件邀请流程，收件人接受邀请链接后才正式加入；邀请 7 天后过期，群组管理员可取消
- **子文件夹导航** — 支持嵌套文件夹（如 `旅游/北京`）；面包屑导航；文件夹间拖拽移动；额外文件夹按上下文存入 `localStorage`
- **文件夹返回栈** — 文件夹视图中，系统/浏览器返回键先逐级返回上层文件夹，再退出应用
- **会话持久化** — 最近使用的群组空间和当前文件夹路径按用户存入 `localStorage`；刷新后恢复原位
- **回收站** — 删除照片时软删除（blob 元数据 `deletedAt`）；专用 🗑️ 回收站标签支持恢复到原文件夹或彻底删除；「清空回收站」批量永久删除
- **移动端固定回收站操作** — 小屏上恢复和永久删除操作固定在底部操作栏，支持单手操作
- **受保护的回收站任务** — 单张恢复/永久删除、全部恢复、清空回收站和文件夹级恢复/删除共用同步 operation gate；任务按稳定快照串行处理并隔离单项失败，桌面、卡片、文件夹和移动端固定操作均真实禁用
- **可停止的永久操作** — 回收站任务可停止当前请求且不会启动下一项；已完成的永久删除不会伪造回滚，界面保留完成/失败统计并重新加载远端状态。运行期间关闭设置、切 Tab/空间、关闭页面和 PWA 更新均受统一保护
- **受保护的批量操作** — 多选模式支持批量删除、移动、重命名、设置拍摄时间和修改 GPS；mutation 期间禁用选择、编辑、移动与上传冲突入口，并纳入全局离开/更新守卫
- **原子且可恢复的文件夹重命名** — 仅允许同级改名；服务端以最多 101/1 条的分页预检检查源/目标前缀，并为整批 copy 复用一次可取消的 delegation-key 请求，再以目标端 `ifNoneMatch=*` 和源 ETag 条件复制全部原图与派生媒体。copy 后复核完整 inventory，删除每个源前以 60 秒短租约锁住并核验对应目标的 copyId + final ETag，源删除关键区最多 20 秒，再按源 ETag 条件删除。copy/delete 使用独立的 4 路小并发，故障期 rollback 降为 2 路；首个 copy 失败即停止派发新任务，已启动任务 settle 后统一安全回滚。单次最多处理 100 个 Blob，copy phase 120 秒后按 copyId 直接终止在途 Azure copy，rollback 最长 60 秒，服务端 210 秒总边界低于客户端 220 秒上限；429/503/ServerBusy 只使用 Azure SDK 的 Retry-After/指数退避，不叠加应用层重试。目标已存在时拒绝覆盖/合并；复制失败只回滚仍可证明归属本操作的目标，任何并发变化或部分删除都保留至少一份并明确报告。根目录与递归文件夹卡片外层是有稳定名称的非交互 group；独立原生按钮提供 Enter/Space 进入和包含完整文件夹名、照片数的可访问名称，busy 时真实 disabled，重命名/删除按钮保持为非嵌套兄弟 Tab stop、至少 44×44 命中区域并具备可见焦点
- **照片卡片键盘主操作** — 时间线、历史回忆、重要片段和文件夹共用语义 `group` PhotoCard；独立原生按钮以文件名、媒体类型和日期命名，普通模式 Enter/Space 打开 viewer，批量模式复用选择动作并通过 `aria-pressed` 表达状态。收藏/删除保持为非嵌套兄弟按钮和至少 44×44 命中区域；普通模式还可用 Shift+F10 或菜单键打开具名操作菜单，方向键/Home/End 导航、Enter/Space 执行、Escape 或外部点击关闭并安全恢复焦点。删除确认复用共享 `alertdialog` 边界，默认聚焦取消、约束 Tab、支持 Escape/外部关闭，并在请求进行中保护关闭及恢复仍连接的删除或照片主按钮。文件名、日期和文件夹计数至少满足 4.5:1，操作图标、选择边界与焦点环至少满足 3:1；音频卡只渲染本地“语音备忘录”占位与类型徽章，不挂载原始或派生媒体 URL，同时继续复用同一键盘主操作、删除和操作菜单；GIF 控制、视频封面修复、拖放与 touch 继续独立
- **受保护的文件夹重命名等待** — 同步 operation gate 防双击，运行期间真实禁用文件夹、批量、上传、移动与删除冲突入口，并纳入 Tab、群组、beforeunload 与 PWA 更新守卫；空间漂移会中止客户端等待，成功、失败或超时都会使用当前空间的最新刷新回调重新对账，不把旧空间结果应用到新空间
- **网络感知的有界并发上传** — 4G 最多并行 3 张图片或 1 视频 + 1 图片，未知/3G 并行 2 张小图，省流/2G 串行；真实批次字节、单调线传输速度、独立成功/失败/取消统计、暂停新任务、稳定 uploadId 和状态型重试保持部分失败可对账
- **照片下载** — 浏览器通过附件 SAS 直连 Blob 下载原始文件，不经 Functions 缓冲（移动端与桌面端均支持）
- **过期分享链接** — 生成单张照片的公开可读链接，TTL 可选（1小时 / 24小时 / 3天 / 7天）
- **一键分享复制** — 优先使用 Clipboard API，自动兜底到传统复制，最后降级为手动复制提示
- **托管分享链接（云端）** — 设置页可提前吊销链接或延长有效期，维护每条链接的状态与生命周期
- **文件夹分享对话框** — 分享当前文件夹时弹出专用对话框并明确选择时长，工具栏保持紧凑
- **托管分享筛选** — 云端分享链接支持按状态（有效/已过期/已吊销）和文件名模糊搜索
- **灵活延长分享** — 托管链接可按预设时长延长（1小时 / 24小时 / 3天 / 7天 / 30天）
- **分享统计** — 每条托管分享链接记录创建时间、浏览次数和最近访问时间
- **自动过期对齐** — 列出托管链接时，后端自动将时间已过期的有效链接标准化为「已过期」
- **乐观并发与上传幂等** — 元数据更新/移动/删除/恢复/分享维护均使用条件写入（ETag + 重试）；每个上传文件携带稳定 UUID，网络重试只会命中同一 Blob
- **角色感知的私有缓存** — 照片列表、媒体缓存与本地重要片段统计按 `用户 + 角色 + 工作区` 授权快照管理，近期公开分享链接按 `用户 + 角色` 管理；管理员降权、切号或注销会立即清理旧列表、SAS 媒体、浏览统计、诊断和本地分享 token，同时保留应用代码缓存
- **统一冲突 UX** — 后端返回 `409` 时，前端显示统一 toast（`资源已被他人修改，请刷新后重试`）
- **本地分享链接管理器** — 设置 → 📱 应用只展示当前账号与角色范围内的近期有效分享链接，支持一键复制/打开/删除和批量清除
- **照片重命名** — 不重新上传即可更改任意照片的显示名称
- **移动照片** — 通过 UI 或拖拽在文件夹间移动照片
- **时间线视图** — 按日期分组的照片时间线，默认最新在前
- **📷/☁ 排序方式切换** — 可在「拍摄时间」与「上传时间」两种排序之间切换；无拍摄时间时自动回退到上传时间
- **受保护的历史维护任务** — 历史缩略图生成与照片元数据回填按绑定账号空间的不透明游标逐页执行；位置恢复先做只读 dry-run，展示候选数和预计读取量并要求确认，执行时显示恢复、真实缺失、无效清理、预算跳过和实际读取字节。任务期间禁止重复启动、关闭设置、切 Tab/空间、关闭页面或激活 PWA 更新；切号、卸载或空间漂移会中止当前请求及后续分页
- **照片地点可靠恢复** — 照片 GPS 继续以 Blob metadata 为事实源；纬度/经度按有限数值和 `[-90,90]`/`[-180,180]` 原子校验，空白、`NaN`、Infinity、越界及单边值均进入恢复。维护仅对非删除图片做按 MIME 分层、每文件硬上限和每页 8 MiB 预算的 Blob range EXIF 扫描；完整无 GPS 才清理无效 pair 并删除陈旧索引，不完整扫描保留为可重试。已有合法 GPS 不下载原图并可幂等重建索引
- **记忆地图键盘与触控访问** — 每个照片标记使用稳定文件名作为可访问名称，并以不偏移地理坐标的 44×44px 命中区支持 Tab、Enter、Space 和清晰焦点；详情与位置编辑统一采用共享 modal boundary，具备初始焦点、动态 Tab 循环、Escape/背景关闭和仅向仍连接触发器回焦。手动坐标在所有入口统一执行完整数值与纬经度范围校验
- **以照片为主的聚焦工具栏** — 首页顶部工具栏轻量展示当前空间、数量、运行模式及高价值导航入口
- **全高局部宽侧边栏** — 时间线和重要片段使用占横向 80%–90% 的右侧全高面板，其余区域变暗，视觉上明确是「侧面弹出工具面板」
- **侧栏筛选自适应重排** — 时间线 `FilterBar` 通过显式 sidebar variant 按容器宽度重排：搜索与清空保持独立首行，快捷筛选和网格尺寸自动换行；320–480px、200% 缩放、长中英文标签和激活 chip 均保持完整可见及 44px 触控目标，桌面默认布局不变
- **侧栏键盘与辅助技术隔离** — 关闭的侧栏保留滑出动画但通过原生 `inert` 和 `aria-hidden` 退出 Tab 顺序与辅助技术树；打开后作为有标题的 modal drawer 聚焦关闭按钮、动态循环 Tab、支持 Escape/背景关闭，并只向仍连接的桌面 FAB 或紧凑触发器恢复焦点
- **移动端控件与中文日期一致性** — 真实 320px 视口下 262px 抽屉的筛选行稳定为 224/224px client/scroll width，控件边界与页面均无横向溢出。筛选器、拍摄时间编辑和时光胶囊复用同一原生控件字体/高度规范，日期数字使用等宽数字并保留系统日历入口；时光胶囊的默认、最小与创建日期按本地日历序列化，不受 UTC 跨日影响。时间线分组、照片卡片及时间线/文件夹查看器复用显式 `zh-CN` 格式化。390px 触屏下仅将照片收藏/删除与头像命中区提升到 44×44px；320/360px 文件夹卡片改为单列。≤480px 的 WorkspaceFab 默认收成 48px 启动器，展开面板始终留在视口内，点击外部或执行动作后收起且不从新界面抢回焦点
- **快速日期筛选 chip** — 「今日 / 本周 / 本月 / ⭐ 收藏」一键 chip 行，无需打开侧边栏即可即时按日期范围筛选；激活时高亮并出现「✕ 清空」
- **激活筛选指示点** — 任意筛选激活时时间线页签标签上出现橙色小点
- **空相册首次引导** — 空间无照片时显示「还没有照片」友好提示和直达上传入口
- **传输进度横幅** — 上传、下载、回收站 mutation、批量 mutation、文件夹重命名与历史维护任务共用固定横幅；文件夹重命名明确显示 `旧名称 → 新名称`，未知服务端进度时不伪造百分比
- **跨部署 lazy chunk 自恢复** — React 启动前捕获可信的同源 hashed JS/CSS 加载失败，安全会话最多自动恢复一次；先有界激活 waiting Service Worker，再用 cache-busting 导航越过旧 index/SW。上传、下载、语音、批量、回收站、维护或文件夹重命名期间保持 0 次刷新，任务结束后自动继续；每个 Tab 使用独立错误边界，文件夹失败不会遮掉已加载时间线，用户界面不显示 chunk URL、SAS 或技术错误
- **返回顶部按钮** — 滚动 500px 后出现悬浮圆形按钮，一键平滑回顶；侧边栏锁定滚动时隐藏
- **窗口聚焦自动刷新** — 切回应用时静默重新获取照片列表（每 60 秒最多一次），多设备编辑无需手动刷新
- **键盘快捷键** — R=刷新；1–6=切换 Tab；S=切换侧边栏；Backspace/Delete=清空筛选；?=快捷键速查表；Esc=关闭任意浮层；输入、按钮、链接、可编辑控件、IME、已处理事件与打开的模态层均不会触发背景快捷键，长按 R/数字也不会重复刷新或切换
- **无障碍工作区页签** — 六个主视图使用具名 WAI-ARIA tablist/tab/tabpanel 关系、稳定 ID 与 roving tabindex；左右方向键循环自动激活，Home/End 跳到首尾，Enter/Space 保留原生按钮行为。所有入口继续复用统一切换与 mutation guard，拒绝切换时 selected 和焦点留在原页签；弹窗打开时不允许后台页签响应，移动端聚焦页签仅在横向条内滚动到可见位置；浅色界面的默认、悬停、选中与禁用文字及数字徽章满足 4.5:1，实色焦点环满足 3:1，选中状态同时使用粗体、底边和底纹
- **跳到主要内容** — 已登录工作区的首个键盘焦点是仅在聚焦时显示的中文 skip link，动态指向当前 active tabpanel；聚焦使用受控滚动且不改变横向文档位置，320px 仍保留 12px 边距。侧边栏打开时该入口退出 Tab 序列，模态层继续通过共享 inert/focus boundary 阻止焦点逃到后台
- **全局文件意图隔离** — 截图粘贴与桌面文件拖入复用快捷键的交互控件/模态层判定，并读取最新的上传、下载、删除、语音、批量、回收站与维护 activity；弹窗后方不会上传或切换 Tab，受阻拖放仍阻止浏览器打开本地文件
- **时间线排序切换** — 「↓ 最新 / ↑ 最早」chip 即时翻转日期分组顺序，无需修改任何筛选条件
- **群组上下文 header badge** — 浏览群组空间时，`👥 群组名` 徽章出现在应用标题旁
- **Toast 关闭按钮** — 每条 toast 通知含 ✕ 按钮，可在 3.5 秒自动消失前手动关闭
- **FAB 筛选数量 badge** — 任意时间线筛选激活时，悬浮胶囊显示橙/红渐变 badge 标注激活数量
- **安装横幅自动消失** — PWA 安装建议横幅 10 秒无操作后自动隐藏
- **群组切换筛选重置** — 切换个人空间与群组时自动清空所有时间线筛选，防止跨空间搜索残留
- **上传文件名进度** — 上传进度追踪当前正在发送的文件名，而非通用计数
- **照片数量 header badge** — 数量显示千分位格式（如「1,234 张」），近 7 天有上传时显示绿色「+N 近7天」徽章
- **历史回忆** — 自动显示往年同月同日拍摄的「历史回忆」照片
- **重要片段 Tab** — 照片按互动热度排序，显示在独立 ⭐ Tab 中；独立筛选和排序方式；固定展示前 20 张最佳照片
- **重要片段跨设备统计** — 在重要片段中打开/切换记录浏览量到后端（Cosmos），包含总浏览量、最近查看时间、常看用户和高峰日；计数器在 Cosmos 中原子更新
- **重要片段计数稳定** — 客户端合并乐观更新与服务端响应，防止延迟响应导致可见数字回退或抖动
- **重要片段本地兜底** — 后端 moments 暂时不可用时，客户端只在当前账号、角色和个人/群组工作区范围内跨刷新保存浏览计数，并将该范围标记为「仅本地」直到服务端同步恢复
- **重要片段诊断页** — 设置中专用诊断 Tab，显示前端版本/构建时间、Service Worker 数量、当前授权工作区的本地 moments 缓存大小及持久化状态
- **卡片化设置面板** — 设置使用更强的视觉层级：hero header、分组卡片、更密集的信息块，个人资料/安全/应用/诊断内容更易扫读
- **设置图标克制化** — 设置 hero 图标改用场景分色色调，不再全部使用饱和蓝渐变
- **设置深度链接** — 首页操作卡可直接打开设置中的应用或诊断页签并滚动到对应区域
- **重要片段详情聚焦** — 重要片段弹窗详情优先展示推荐值 + 互动指标，而非时间线风格的上传/修改元数据
- **可恢复空状态** — 时间线和重要片段空结果状态提供一键重置/跳转到文件夹等恢复操作，替代被动空白屏幕
- **时间线分页** — 时间线优先加载最新一批，可渐进式「加载更多」，保持首屏速度
- **搜索与筛选** — 按名称、主题、上传者、日期范围、缺少主题、未分类筛选
- **全屏弹窗** — 查看完整详情，内联编辑主题/重命名/下载
- **弹窗长文件名安全** — 超长文件名省略显示，不遮挡重命名等操作按钮
- **弹窗键盘导航** — ← / → 在文件夹或时间线中切换照片；Esc 关闭；prev/next 按钮支持鼠标/触摸
- **图标控件无障碍名称** — 关闭、清空、导航、播放、收藏和编辑按钮提供准确 ARIA 名称；网格、收藏、全屏与照片选择状态可由屏幕阅读器识别
- **Toast 通知系统** — 轻量 React-Context toast 队列（success/error/info）；3.5 秒后自动消失
- **图片加载骨架屏** — 每张缩略图加载时显示闪光骨架，加载完成后淡入，消除布局偏移
- **激活筛选 chip** — 已应用的主题/上传者/日期筛选以可关闭 chip 形式显示在搜索栏下方
- **名称搜索防抖** — 名称筛选 300ms 防抖，提交时合并最新主题、日期和收藏状态；清空、外部重置或侧栏卸载会取消旧任务，连续输入只提交最后值
- **全选 / 取消全选** — 批量模式下时间线和文件夹视图均支持一键全选切换
- **批量删除确认对话框** — 批量删除前需明确确认
- **有界并发批量移动** — 文件夹批量移动最多同时发出 4 个请求；reject 与 `false` 结果逐项计入失败，单项失败不会跳过剩余照片或最终清理
- **加载 spinner** — 照片获取期间动态 CSS spinner 替代静态「加载中...」文字
- **重试按钮** — 加载失败状态显示「重试」按钮，无需刷新页面即可重新获取
- **丰富空状态** — 照片图标 + 中文提示替代纯文字占位符
- **删除二次确认** — 自定义确认对话框（不使用浏览器 `alert`）
- **移动端响应式** — ≤680px 时 2 列网格、紧凑 header、触摸友好弹窗；文件夹 Tab 移动端适配两列
- **移动端横向稳定** — 本周概况继续贴合视口 full-bleed，但 320/390px 下根文档不再横向滚动；Tab 导航仍保留自身独立横向滑动
- **移动端悬浮操作收纳** — 320–480px 常见手机宽度默认只显示 safe-area 对齐的 48px 快捷入口；展开面板在 200% 缩放下不越界，执行操作、点按外部或按 Escape 后自动收起，并保留焦点回归和 `aria-expanded`
- **统一中文照片日期** — 时间线分组、照片卡片、时间线详情与文件夹详情统一使用显式 `zh-CN` formatter；无效时间安全显示为空，日期筛选和 API 值仍保持 `YYYY-MM-DD`
- **照片操作触控目标** — 移动、收藏、删除和账号头像提供至少 44×44px 的非重叠命中区，图标视觉密度保持不变
- **管理员工具** — 超级管理员（通过 `SUPER_ADMIN_USERNAME` 环境变量配置）可将其他用户提升为 admin
- **PWA 应用模式** — 可安装为桌面/移动应用；中文 manifest、标准 192/512 PNG、iOS 180px 主屏幕图标及标准/Apple mobile-capable meta 保持跨平台安装兼容
- **PWA 安装入口不占 Header** — 已登录 Header 只保留空间切换、照片数量和用户菜单；安装能力保留在登录页、用户菜单与「设置 → 应用」
- **Header 菜单完整键盘访问** — 空间切换与用户菜单使用一致的 menu 键盘模型，支持方向键、Home/End、Escape、Tab 和焦点恢复；禁用项会被跳过，受保护的空间切换不会改变当前空间或意外关闭菜单；菜单正文、图标与焦点环分别满足 4.5:1、3:1 对比度
- **自动隐藏导航保持焦点可见** — Header 或工作区页签通过 Tab、Shift+Tab、方向键、Home/End 接收焦点时会同步恢复到视口，并以 `nearest` 校正焦点矩形；焦点留在任一导航容器、菜单/侧栏打开或任意模态层活跃期间，后续滚动不能再次隐藏导航。控件保持正常 Tab 可达而不使用 inert，共享弹窗边界仍只向已连接且可见的触发器恢复焦点
- **共享弹窗焦点边界** — 新建群组、群组设置、快捷键帮助、安装指引和添加管理员提供标准 dialog 语义、动态 Tab/Shift+Tab 循环、嵌套弹窗隔离及 connected-only 焦点恢复；保存、邀请、添加或删除进行中时不能通过遮罩或 Escape 提前关闭
- **时光胶囊有界且隔离的记忆选择** — 新建胶囊首批只挂载 18 个记忆项；滚动到底或用键盘遍历到当前批次末项时每次追加 12 项。同一空间内切换来源或重开创建器会重置窗口但保留完整选择 Set，切换空间会挂载该空间的新选择状态；视频只显示静态派生封面，音频只显示零网络本地占位。本地胶囊按用户与空间分区，旧数据只迁入个人空间；读写失败会显式提示，损坏、越界或含 SAS URL 的记录会被安全丢弃
- **自动故事语义进度轴** — 自动故事只纳入图片和已有安全派生封面的视频，音频及无封面视频不进入预览、计数或播放器；任意媒体数量都只渲染一个原生 range scrubber，支持方向键、Home/End、点击与拖动跳转并同步自动播放、前后切换和计数；关闭、卸载或快速连续导航会清理 200ms 过渡任务
- **批量与文件夹操作焦点边界** — 时间线/文件夹批量删除、文件夹分享与快速移动统一使用共享 dialog boundary，具备命名/描述、合理初焦、动态 Tab 循环、Escape 和 connected-only 焦点恢复；分享或移动 mutation 期间禁止提前关闭
- **PWA 快速更新模式** — 网页与已安装 App 共用自动更新 Service Worker；首装只预缓存应用壳，功能 chunk 首次使用后缓存；检测到新版本后仅提示并持久化 `update-ready` 状态，必须由用户点击触发更新
- **PWA 更新传输守卫** — 上传/下载/批量删除/回收站 mutation/语音备注录制或上传/批量 mutation/历史维护任务进行中时，更新按钮禁用并提示任务完成后更新；同一守卫阻止切 Tab、切群组和关闭页面
- **登录首屏分包** — 未认证访客只加载鉴权壳；工作区、图库与注册表单按用户意图加载，入口 JS 从 179.82 kB 降至 26.58 kB（约 -85%），首屏 CSS 从 128.56 kB 降至 9.38 kB
- **更新弹窗延后挂载** — `WhatsNewPopup` 改为独立 lazy chunk，并仅在照片列表完成后通过 `requestIdleCallback(timeout=2000)+fallback` 调度挂载；`AuthenticatedApp` 初始 chunk 从 95.43 kB 降至 92.59 kB（gzip 30.80 kB → 29.98 kB），避免与首批照片请求争抢关键路径
- **最近更新键盘无障碍** — 弹窗打开后聚焦关闭按钮，Escape 可关闭，Tab/Shift+Tab 会按当前展开内容循环；键盘聚焦会停止自动淡出，关闭动画结束或卸载时仅向仍连接的原元素恢复焦点，更新条目改用带稳定 `aria-controls` 的原生按钮
- **设置模态键盘隔离** — 设置面板与侧栏共用可堆叠 modal boundary 和 `body` 级 portal；打开后聚焦关闭按钮并动态 trap Tab，Escape 复用维护/回收站关闭保护，从侧栏动作进入设置再关闭时会恢复到原动作，其他按键不会穿透背景
- **阅读进度条** — 视口最顶部一条渐变细条，随时间线滚动填充，提供即时空间定位感
- **全局拖拽提示** — 向应用窗口拖入图片文件时触发全屏引导覆盖层，drop 后自动跳转文件夹视图
- **键盘快捷键帮助面板** — 随时按 `?`（或点击 header 中 ⌨️）打开悬浮快捷键速查表；再按 Escape 或 `?` 关闭
- **Backspace/Delete 清空筛选** — 任意筛选激活且焦点不在输入框时，按 Backspace/Delete 一键清空所有时间线筛选并附 toast 确认
- **文件夹快速筛选 chip** — 时间线 chip 行最多显示 4 个文件夹 chip，一键将时间线限定在某一文件夹内
- **今日上传提示** — 今日有上传时，时间线网格上方显示绿色提示条并含一键切换「今日」筛选的按钮
- **时间段问候语** — header 标题显示上下文问候（「早上好」、「下午好」、「晚上好」）
- **上传文件大小摘要** — 上传进度横幅同时显示总文件数和 MB（如「5 张 · 12.3 MB」）
- **本周概况卡** — 可折叠「📊 本周概况」卡片，显示本周上传、总收藏、文件夹数、已用存储（从 blob size 元数据聚合）和今日数量；含「📋 复制周报」按钮
- **开发刷新稳定** — Vite 开发模式下 SW 注册默认禁用，避免本地开发刷新循环
- **传输安全守卫** — 上传/下载、批量删除、回收站 mutation、语音、批量 mutation 与历史维护任务进行中时阻止 Tab/空间切换，浏览器刷新或关闭显示 unload 确认
- **无密钥安全** — 存储和数据库均无账户密钥；使用 `DefaultAzureCredential`（Azure 上托管身份，本地 Azure CLI）
- **统一前端安全头** — 主域与 Azure 直连入口均限制跨站 iframe 嵌入，并锁定 MIME 嗅探和 referrer 基线
- **CI/CD** — GitHub Actions + OIDC 认证（无存储密码）；前后端分离 workflow，仅在相关路径变更时触发
- **自动隐藏 header** — 向下滚动时顶部导航栏滑出，向上滚动或回顶时立即重现；键盘焦点、Header 菜单与其弹窗会暂时锁定可见状态并跳过过渡，其他场景保留 300ms cubic-bezier 平滑动画
- **导航圆角遮罩** — 全宽页面背景覆盖层包裹 sticky tab shell，遮蔽透明圆角区域，防止照片内容在滚动时透过卡片边缘渗出
- **弹窗双指缩放** — 照片详情弹窗支持双指捏合缩放和双击缩放，自然的移动端检视；平滑 CSS transform + 惯性释放
- **弹窗滑动切换** — 详情弹窗中水平滑动手势切换上/下一张照片
- **批量主题标签编辑** — 批量选择模式下为多张照片一次性应用或替换主题标签
- **照片搜索栏** — 持久搜索输入框，同时模糊匹配文件名和主题；300ms 防抖；激活时显示清除按钮和结果计数
- **上传拖拽预览** — 文件拖入时全屏覆盖层显示拖拽目标和来自拖拽载荷的文件数，在 drop 前提供即时反馈
- **文件夹配额指示** — 文件夹视图每个文件夹显示照片数相对于软上限的小进度条
- **智能日期分组标签** — 时间线日期分组 header 对近期使用相对标签（「今天」、「昨天」、「本周」、「上个月」），较早的使用 ISO yyyy-mm-dd
- **上下文空状态操作** — 空文件夹视图显示「上传照片」和「新建子文件夹」两个 CTA

---

## 角色系统

| 角色 | 权限 |
|------|------|
| `admin` | 查看全部照片（私有 + 所有群组）；可添加管理员 |
| `viewer` | 查看自己的私有照片 + 已加入群组的照片 |

群组内：

| 群组角色 | 权限 |
|----------|------|
| `admin` | 添加/移除成员，更新或删除群组 |
| `member` | 查看并上传照片到群组 |

仅超级管理员（通过 `SUPER_ADMIN_USERNAME` 环境变量配置）可将用户提升为全局 `admin`。

---

## 数据模型

### UserDoc（`users` 容器）
```jsonc
{
  "id": "<uuid>",
  "username": "alice",
  "email": "alice@example.com",
  "displayName": "Alice",
  "passwordHash": "<bcrypt, cost 10>",
  "role": "admin" | "viewer",
  "privateFolders": ["Holidays", "Work"],
  "createdAt": "2025-01-01T00:00:00Z",
  "lastLoginAt": "2025-06-01T12:00:00Z"
}
```

### GroupDoc（`groups` 容器）
```jsonc
{
  "id": "<uuid>",
  "name": "家庭旅行",
  "description": "2025 年夏",
  "createdBy": "<userId>",
  "createdAt": "2025-06-01T00:00:00Z",
  "members": [
    { "userId": "...", "username": "alice", "email": "...",
      "displayName": "Alice", "role": "admin",
      "joinedAt": "...", "addedBy": "..." }
  ],
  "folders": ["到达", "海滩", "告别"]
}
```

### InviteDoc（`invites` 容器）
```jsonc
{
  "id": "<uuid token>",        // 同时是分区键；在邀请链接中发送
  "groupId": "<uuid>",
  "groupName": "家庭旅行",
  "email": "bob@example.com",  // 小写；必须匹配收件人账户邮箱
  "invitedByUserId": "<uuid>",
  "invitedByName": "Alice",
  "status": "pending",         // pending | accepted | declined | cancelled
  "createdAt": "2025-06-01T00:00:00Z",
  "expiresAt": "2025-06-08T00:00:00Z",  // 创建后 7 天
  "respondedAt": "2025-06-02T10:00:00Z"
}
```

### MomentInsightDoc（`moments` 容器）
```jsonc
{
  "id": "moment:<base64url(photoName)>",
  "photoName": "personal/<userId>/<folder>/<file>",
  "scopeType": "personal" | "group",
  "scopeId": "<userId or groupId>",
  "totalViews": 12,
  "lastViewedAt": "2026-05-28T09:30:00Z",
  "lastViewedBy": "Alice",
  "viewers": { "Alice": 9, "Bob": 3 },
  "dailyViews": { "2026-05-27": 4, "2026-05-28": 8 },
  "createdAt": "2026-05-25T10:00:00Z",
  "updatedAt": "2026-05-28T09:30:00Z"
}
```

重要片段评分模型（前端）：

$$
\text{推荐值} = (\text{已收藏}?120:0) + (\text{有主题}?20:0) + \max(0, 40-\text{距今天数})
$$

$$
\text{互动热度} = \text{推荐值} + 24 \times \text{总浏览量} + \text{近期浏览加成}(0..72h)
$$

### Blob 元数据（Azure Blob Storage 每张照片）
```
originalName      Base64 编码的原始文件名
subject           可选主题/说明
folder            文件夹名（空 = 未分类）
groupId           所属群组（空 = 私有）
createdBy         上传者显示名
createdById       上传者 userId
createdAt         ISO 8601 时间戳（上传时间）
takenAt           拍摄时间（naive datetime，不带 Z，EXIF 提取或手动设置）
gpsLat            GPS 纬度（字符串，EXIF 提取或手动设置）
gpsLon            GPS 经度（字符串，EXIF 提取或手动设置）
lastModifiedBy    最后编辑者显示名
lastModifiedAt    ISO 8601 时间戳
thumbnailName     400 px WebP 名称（仅在 derivative 上传成功后以 ETag 条件写入）
previewName       2048 px WebP 名称（仅在 derivative 上传成功后以 ETag 条件写入）
```

原图及 derivative 的 Blob HTTP 缓存头统一为 `private, max-age=3600, immutable`；授权 URL 的 SAS 有效期为 2 小时，不配置超出授权期的浏览器 stale window。

---

## API 参考

所有受保护路由均需 `Authorization: Bearer <accessToken>`。

### 认证

| 方法 | 路由 | 鉴权 | 说明 |
|------|------|------|------|
| `POST` | `/api/auth/register` | — | 注册；返回 `{ token, refreshToken, user }` |
| `POST` | `/api/auth/login` | — | 登录；返回 `{ token, refreshToken, user }` |
| `GET`  | `/api/auth/me` | ✓ | 获取当前用户信息 |
| `POST` | `/api/auth/refresh` | 刷新令牌 | 用刷新令牌换取新访问令牌 + 刷新令牌（滚动） |
| `POST` | `/api/auth/admins` | 仅管理员 | 将用户提升为管理员 |

### 照片

| 方法 | 路由 | 鉴权 | 说明 |
|------|------|------|------|
| `GET`    | `/api/photos[?groupId=<id>]` | ✓ | 列出照片；每个 URL 为 2 小时用户委托 SAS |
| `POST`   | `/api/photos/upload?filename=<name>[&uploadId=<uuid>&folder=<path>&groupId=<id>&gpsLat=<lat>&gpsLon=<lon>]` | ✓ | 上传（原始二进制 body）；`uploadId` 令重试幂等，群组上传要求成员身份；拒绝非图片/视频 MIME（415）和超大文件（413） |
| `GET`    | `/api/photos/download?name=<blobName>&filename=<displayName>` | ✓ | 校验个人/群组路径后返回短效附件 SAS；不代理文件体 |
| `GET`    | `/api/photos/share?name=<blobName>&hours=<1..168>` | ✓ | 创建过期分享链接（`{ url, expiresAt }`） |
| `GET`    | `/api/photos/share/open/{linkId}` | — | 打开托管公开分享链接（重定向到短效 SAS 并增加浏览统计） |
| `GET`    | `/api/photos/share/links[?status=active|expired|revoked&q=<keyword>]` | ✓ | 列出当前用户的托管分享链接，支持状态/名称筛选 |
| `PATCH`  | `/api/photos/share/links/{linkId}` | ✓ | 立即吊销（`action=revoke`）或延长有效期（`action=extend`, `hours=1..720`）；冲突返回 `409` |
| `POST`   | `/api/photos/moments/insights` | ✓ | 批量查询指定照片的 moments 统计，通过 JSON body `{ photoNames: string[] }`（跨设备持久化） |
| `POST`   | `/api/photos/moments/view` | ✓ | 记录一次 moments 浏览（`photoName`, 可选 `viewerName`），乐观并发 |
| `POST`   | `/api/photos/move` | ✓ | 将照片移动到其他文件夹 |
| `PATCH`  | `/api/photos/metadata?name=<blobName>` | ✓ | 更新主题/文件夹/原始名称/拍摄时间/GPS；冲突返回 `409` |
| `DELETE` | `/api/photos?name=<blobName>` | ✓ | 软删除照片；冲突返回 `409` |
| `POST`   | `/api/photos/backfill?limit=30[&groupId=<id>&cursor=<opaque>&dryRun=true]` | ✓ | 分页恢复非删除图片元数据；`dryRun=true` 只读 metadata 并估算候选/字节，执行时以 ETag 条件 range 读取和写回。返回 `{ processed, updated, candidates, estimatedBytes, bytesRead, recovered, cleanedInvalid, trulyMissing, skippedBudget, indexReconciled, failed, hasMore, cursor }` |

**`GET /api/photos` 所有权规则：**
- `?groupId=<id>` — 请求者必须是该群组成员
- 无 `groupId` — 返回请求者的私有照片（管理员可看全部私有照片）

### 地理编码

| 方法 | 路由 | 鉴权 | 说明 |
|------|------|------|------|
| `GET` | `/api/geocode/search?q=<query>` | ✓ | 地点正向搜索 |
| `GET` | `/api/geocode/reverse?lat=<lat>&lon=<lon>` | ✓ | GPS 反向解析为最小 `{ address }`；严格校验范围，Nominatim 429 透传 `Retry-After` |

正向与反向请求共用每 worker 约 1 req/s 的有界队列、并发去重及 TTL/LRU 缓存；失败不进入长缓存。客户端反向解析缓存只存在于内存，并按认证 generation 与个人/群组 workspace 隔离。

### 群组

| 方法 | 路由 | 鉴权 | 说明 |
|------|------|------|------|
| `POST`   | `/api/groups` | ✓ | 创建群组（创建者成为群组管理员） |
| `GET`    | `/api/groups` | ✓ | 列出用户所在的群组 |
| `GET`    | `/api/groups/{groupId}` | 成员 | 获取群组详情 + 成员列表 |
| `PATCH`  | `/api/groups/{groupId}` | 群组管理员 | 更新名称/描述 |
| `DELETE` | `/api/groups/{groupId}` | 群组管理员 | 删除群组 |
| `POST`   | `/api/groups/{groupId}/members` | 群组管理员 | 通过**用户名**邀请——查找邮箱并创建邀请（返回 202，接受前不加入） |
| `DELETE` | `/api/groups/{groupId}/members/{memberId}` | 群组管理员/本人 | 移除成员 |

### 邀请

| 方法 | 路由 | 鉴权 | 说明 |
|------|------|------|------|
| `POST`   | `/api/groups/{groupId}/invites` | 群组管理员 | 通过**邮箱**发送邀请；创建 InviteDoc，发送接受链接 |
| `GET`    | `/api/groups/{groupId}/invites` | 群组管理员 | 列出群组待处理邀请 |
| `GET`    | `/api/invites/{token}` | —（公开）| 获取邀请信息（供接受页使用）；已过期返回 410 |
| `POST`   | `/api/invites/{token}/respond` | ✓（邮箱须匹配）| 接受或拒绝；接受时将用户加入群组 |
| `DELETE` | `/api/invites/{token}` | 群组管理员 | 取消待处理邀请 |

> `/api/groups/{groupId}/members`（用户名）和 `/api/groups/{groupId}/invites`（邮箱）均使用同一邀请流程：无人可在未明确接受邀请链接的情况下加入群组。

---

## 认证流程

### 注册 / 登录
1. 客户端发送凭据；服务端响应 `{ token, refreshToken, user }`
2. `token` — HS256 JWT，**2 小时**有效期，包含 `{ userId, username, displayName, role }`
3. `refreshToken` — HS256 JWT，**30 天**有效期，携带额外 `tokenType: "refresh"` claim
4. 两个令牌均存储在 `localStorage`

### 静默令牌刷新
1. 任何 API 调用收到 **HTTP 401** 时触发 `getRefreshedToken()`
2. `getRefreshedToken()` 是**互斥锁**——多个并发请求同时 401 时，只发出一次 `POST /api/auth/refresh`；所有等待者收到同一个新令牌
3. 登录、注销、跨 Tab 换号会推进认证 generation 并中止旧刷新；旧请求的迟到 401 不会清除新账号
4. 原请求使用新令牌**自动重试一次**，对调用方完全透明
5. 若刷新令牌本身已过期，用户跳转到登录页
6. 刷新令牌在每次使用时**滚动**（30 天窗口向前推移）

### 会话恢复（页面刷新时）
1. App 从 `localStorage` 读取 `cloudphoto_token`
2. 调用 `GET /api/auth/me` 验证并恢复用户状态
3. 若访问令牌在两次页面加载之间过期，第一次 API 调用触发静默刷新

---

## 本地开发

### 前提条件

- Node.js 24+
- Yarn（monorepo 标准；保持单个根目录 `yarn.lock`）
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- Azure CLI（`az login`——本地由 `DefaultAzureCredential` 使用）

```bash
npm install -g azure-functions-core-tools@4 --unsafe-perm true
```

### 配置

**1. 克隆并安装**

```bash
git clone https://github.com/jinyiyexing518/CloudPhoto.git
cd CloudPhoto
yarn install
```

**2. 配置后端密钥** — 创建 `packages/server/local.settings.json`（已 git-ignore）：

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "STORAGE_ACCOUNT_NAME": "<存储账户名>",
    "STORAGE_CONTAINER_NAME": "photos",
    "COSMOS_ENDPOINT": "https://<cosmos 账户>.documents.azure.com:443/",
    "COSMOS_DATABASE": "cloudphoto",
    "JWT_SECRET": "<随机 48 字节 hex 字符串>",
    "SUPER_ADMIN_USERNAME": "<你的用户名>"
  },
  "Host": { "CORS": "*" }
}
```

> **不需要存储或 Cosmos 密钥。** 后端使用 [托管身份 / DefaultAzureCredential](https://learn.microsoft.com/azure/developer/javascript/sdk/authentication/overview)。
> 本地开发时，`DefaultAzureCredential` 回退到 **Azure CLI 会话**——运行一次 `az login` 即可。

生成 JWT secret：
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

本地开发时，为你自己的 Azure AD 身份授予以下角色：

```bash
# 存储：Blob 数据贡献者 + Blob 委托者
az role assignment create --assignee <YOUR_PRINCIPAL_ID> \
  --role "Storage Blob Data Contributor" \
  --scope /subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.Storage/storageAccounts/<STORAGE>

az role assignment create --assignee <YOUR_PRINCIPAL_ID> \
  --role "Storage Blob Delegator" \
  --scope /subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.Storage/storageAccounts/<STORAGE>

# Cosmos DB：内置数据贡献者
az cosmosdb sql role assignment create \
  --account-name <COSMOS_ACCOUNT> --resource-group <RG> \
  --role-definition-id 00000000-0000-0000-0000-000000000002 \
  --principal-id <YOUR_PRINCIPAL_ID> \
  --scope /subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.DocumentDB/databaseAccounts/<COSMOS_ACCOUNT>
```

**3. 本地运行**

```bash
# 终端 1 — 后端
yarn dev:server                   # func start，监听 localhost:7071

# 终端 2 — 前端
yarn dev:client                   # Vite，监听 localhost:3000（代理 /api → :7071）
```

打开 [http://localhost:3000](http://localhost:3000)。

### 功能文件夹约定

- 客户端分享功能工具类统一放在 `packages/client/src/features/share/`。
- 服务端分享相关 HTTP 函数统一放在 `packages/server/src/functions/share/`。
- 新增跨切面功能按领域分组，避免逻辑散落在通用文件夹中。

---

## Azure 配置

### Cosmos DB

1. 门户 → **Azure Cosmos DB** → **+ 创建** → **NoSQL API** → **无服务器**（免费套餐）
2. 创建数据库 `cloudphoto`，包含以下容器：

   | 容器 | 分区键 |
   |------|--------|
   | `users`      | `/id` |
   | `admins`     | `/id` |
   | `groups`     | `/id` |
   | `invites`    | `/id` |
   | `changelogs` | `/id` |
   | `moments`    | `/id` |

3. 在 `admins` 容器中预置超级管理员条目：
   ```json
   { "id": "your@email.com", "email": "your@email.com", "username": "yourusername" }
   ```

> 如果容器不存在，首次运行时会自动创建。

### Azure Blob Storage

1. 创建存储账户（如 `photostorage`）
2. 创建名为 `photos` 的容器，访问级别设为**私有**
3. 不需要访问密钥——为托管身份授予 RBAC 角色（见下方）
4. 如果分享链接需要在公网打开，存储账户网络设置必须允许公网访问（或等效路由访问）

### Function App 应用设置

| 名称 | 值 |
|------|----|
| `COSMOS_ENDPOINT` | Cosmos DB URI |
| `COSMOS_DATABASE` | `cloudphoto` |
| `JWT_SECRET` | 随机 48 字节 hex 字符串 |
| `STORAGE_ACCOUNT_NAME` | `photostorage` |
| `STORAGE_CONTAINER_NAME` | `photos` |
| `SUPER_ADMIN_USERNAME` | 超级管理员用户名 |
| `ACS_ENDPOINT` | Azure Communication Services 端点 URL（推荐生产环境，配合托管身份使用）|
| `ACS_CONNECTION_STRING` | ACS 连接字符串（本地开发回退，托管身份不可用时使用）|
| `ACS_SENDER_ADDRESS` | ACS 邮件验证发件人地址（如 `DoNotReply@<uuid>.azurecomm.net`）|
| `APP_BASE_URL` | 应用公网 URL，嵌入邀请链接（如 `https://yourapp.azurestaticapps.net`）|

> **邮件邀请（托管身份）：** 生产环境设置 `ACS_ENDPOINT`（而非 `ACS_CONNECTION_STRING`），并为 Function App 托管身份授予 ACS 资源的 **Communication Services Contributor** 角色。本地开发才需要 `ACS_CONNECTION_STRING`。

> `STORAGE_ACCOUNT_KEY` 和 `COSMOS_KEY` **不需要**——Function App 使用托管身份。

---

## 托管身份与 RBAC 配置

后端使用 `DefaultAzureCredential`，不存储任何存储或数据库凭据。

### 1. 启用系统分配托管身份

门户 → `cloudphoto-api` → **标识** → **系统分配** → 切换为**启用** → **保存**。

### 2. 授予存储角色

```bash
MI_PRINCIPAL=<Identity 刀片中的对象 ID>
STORAGE_SCOPE=/subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.Storage/storageAccounts/photostorage

az role assignment create --assignee $MI_PRINCIPAL \
  --role "Storage Blob Data Contributor" --scope $STORAGE_SCOPE

az role assignment create --assignee $MI_PRINCIPAL \
  --role "Storage Blob Delegator" --scope $STORAGE_SCOPE
```

### 3. 授予 Cosmos DB 角色

```bash
az cosmosdb sql role assignment create \
  --account-name <COSMOS_ACCOUNT> --resource-group <RG> \
  --role-definition-id 00000000-0000-0000-0000-000000000002 \
  --principal-id $MI_PRINCIPAL \
  --scope /subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.DocumentDB/databaseAccounts/<COSMOS_ACCOUNT>
```

### 4. 授予 Azure Communication Services 角色（邮件邀请）

```bash
ACS_SCOPE=/subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.Communication/communicationServices/<ACS_NAME>

az role assignment create --assignee $MI_PRINCIPAL \
  --role "Communication Services Contributor" --scope $ACS_SCOPE
```

> 在 Function App 应用设置中配置 `ACS_ENDPOINT`（ACS 资源 URL）和 `ACS_SENDER_ADDRESS`，无需连接字符串密钥。

---

## CI/CD（GitHub Actions）

push 到 `main` 时按变更路径运行部署和同步 workflow，并由独立 workflow 持续检查生产环境：

| Workflow | 文件 | 触发条件 |
|----------|------|----------|
| 部署后端 | `.github/workflows/deploy-backend.yml` | `packages/server/**` 或共享算法运行时代码/构建元数据变更 |
| 部署前端 | `.github/workflows/deploy-frontend.yml` | `packages/client/**`、共享算法运行时代码/构建元数据或 PR 变更 |
| 同步更新日志 | `.github/workflows/sync-changelog.yml` | `changes/**` 变更 |
| 生产健康检查 | `.github/workflows/production-health.yml` | 每 30 分钟、手动触发、前端或后端部署完成 |

部署和更新日志同步 workflow 使用 **OIDC 认证**（无存储的 Azure 密码/密钥）；生产健康检查仅需仓库只读权限。共享算法仅在 `src/**`、`package.json` 或 `tsconfig.json` 变化时触发生产部署，README 等文档修改不会重建前后端。前端 production push 与 `main` 上显式选择 production 的手动运行共用单一 concurrency group，运行中的 upload 不会被后续 run 取消；GitHub 最多保留 1 个 pending，同目标更多事件只会在进入 Azure 前 coalesce，因此不会再制造 Azure Deployment Canceled failure。PR 与 validation 使用独立 group，可取消旧验证。`workflow_dispatch` 默认 `validate`，当前 workflow 中非 `main` 分支与所有 PR 始终只构建和检查，upload 数量为 0。production job 只在 `main` 上通过 OIDC 从 Azure 即时读取 SWA deployment token，且当前 workflow 不引用 repository deployment token；要让仍含历史 workflow 的旧分支也无法取得生产凭据，必须按部署契约删除旧 repository secret。Production Health 只把确实启动过 `Deploy production` 的 Frontend run 当部署事件，validation 或 Azure 前 coalesce 不会伪造生产红灯。classifier 通过 attempt-specific jobs API 读取事件对应的 `run_attempt`，避免重跑复用 run ID 时把一个 attempt 的 conclusion 与另一个 attempt 的 jobs 混合；失败与非部署检查也用 run ID + attempt 隔离。`workflow_run` 先在隔离目录读取健康 workflow 自身版本的 classifier；通过分类后才把触发部署的 `head_sha` checkout 到独立验证目录，所有 contract/full-smoke 脚本与报告都绑定该 SHA，而不是可能已经前移的 `main`。分类器必须完整输出布尔 verdict，旧版或损坏输出会 fail closed；controller 另以 marker-only smoke 固定执行线上 SHA guard，因此历史部署版本即使没有新 smoke 逻辑也不能假绿。前端生产 artifact 同时写入仅含 commit SHA 的 no-store `deployment.json`，线上检查要求主域与 SWA 直连都精确返回该 SHA。前端构建配置使用 `packages/client/vite.config.mts` 和 Vite ESM Node API，静态契约会拒绝重新引入触发 CJS 弃用警告的 `.ts` 配置。构建产物契约同时要求 `AuthenticatedApp` 与 `PhotoGallery` 保持独立哈希 chunk，防止工作区代码重新进入未登录首屏。

### 生产健康检查

`node scripts/production-smoke.mjs` 使用 Node 24 内置 `fetch` 同时检查主域名和 Azure 直连：两个前端均返回 Cloud Photo HTML，并携带 `SAMEORIGIN`、`frame-ancestors 'self'`、`nosniff` 和 `same-origin` referrer 安全头；两个 manifest 均以 `application/manifest+json` 返回完整安装字段，两张 Apple Touch PNG 均可解码为 180px 图标，两个未登录 `/api/auth/me` 均返回 401，且两个 `/api/changelogs` 均返回 200 JSON 数组；主域还会检查 `/healthz`。普通定时、手动或后端事件同一轮执行 11 个检查；前端 deployment 事件额外检查主域与 SWA 的 no-store `deployment.json`，共 13 个，并要求两者 SHA 与该 Frontend run 的 `head_sha` 完全一致。所有检查并行执行，完成后仍按固定顺序输出目标、状态和耗时；每个请求 10 秒超时，失败后最多重试 8 次、轮次间隔 15 秒，以覆盖前后端部署传播竞态。最坏检查时长为 185 秒（8 × 10 秒并行轮次 + 7 × 15 秒等待，不含 runner setup），低于 workflow 的 10 分钟上限。Frontend production、Backend 与普通定时/手动检查使用相互隔离的成功并发组：同类 deployment 更新会取消旧轮次，但普通、后端或 Frontend validation 检查不能取消前端 SHA 验证；Frontend 非部署完成事件与失败部署按 run ID + attempt 隔离，其显式结果不会被同一 run 的重跑或后续成功事件覆盖。

默认入口为 `https://cloudphotos.top`、`https://brave-sand-053b07a00.7.azurestaticapps.net` 和 `https://cloudphoto-api.azurewebsites.net/api`。可通过 `PRODUCTION_BASE_URL`、`PRODUCTION_AZURE_FRONTEND_URL`、`PRODUCTION_AZURE_API_BASE_URL` 覆盖入口，或使用对应的 `PRODUCTION_HOME_URL` / `PRODUCTION_MANIFEST_URL` / `PRODUCTION_AUTH_ME_URL` / `PRODUCTION_CHANGELOGS_URL` / `PRODUCTION_DEPLOYMENT_URL` 与 `PRODUCTION_AZURE_*` 变量覆盖单个检查地址；仅设置合法 40 位 `PRODUCTION_DEPLOYED_SHA` 时启用精确部署标记检查。运行 `yarn test:production-smoke` 可在本机用内置 HTTP fixture 重复验证成功、重试和失败路径，无需访问生产环境。

`GET /api/changelogs?days=N` 默认查询最近 30 天；`N` 必须是正整数，否则回退 30，且最大限制为 365。

### 所需 GitHub Secrets

| Secret | 值 |
|--------|-----|
| `AZURE_CLIENT_ID` | 服务主体应用程序 ID |
| `AZURE_TENANT_ID` | Azure 租户 ID |
| `AZURE_SUBSCRIPTION_ID` | Azure 订阅 ID |
| `AZURE_FUNCTIONAPP_NAME` | `cloudphoto-api` |
| `AZURE_RESOURCE_GROUP` | `CloudPhoto` |
| `VITE_API_BASE` | `https://cloudphoto-api.azurewebsites.net/api` |

### 更新日志自动化

- **Cosmos DB（线上 WhatsNew 数据）：** `sync-changelog.yml` 在 `changes/**` 有 push 时自动触发，无需手动操作
- **`changelog.json`（静态兜底）：** 部署前端时 CI 自动运行 `node scripts/collect-changes.mjs` 重新生成，打包进静态资源
- **新增 change 文件：** 在 `changes/` 目录创建 `YYYY-MM-DD-id.json`，commit + push，其余全部自动完成

### 前端缓存策略

- Vite 生成的 `/assets/*` 内容哈希文件缓存一年并标记 `immutable`
- SPA shell、Service Worker 和注册入口每次重验证，确保 PWA 能发现新版本
- Service Worker 首装只预缓存 HTML、9.38 kB 登录样式、26.58 kB 入口 JS、React 与注册运行时（180.90 KiB）；工作区 JS/CSS、注册表单与图库等动态 chunk 首次使用后进入 `app-code-v1`，相较原始 894.44 KiB 首装资源减少约 80%
- manifest、静态图标与 `changelog.json` 使用短缓存并重验证；`.webmanifest` 明确返回 `application/manifest+json`
- `packages/client/public/staticwebapp.config.json` 会由 Vite 复制到 `dist` 根目录；CI 同时验证源配置、部署产物和资源文件名
- `cloudphotos.top` 的 Nginx 前端反代透传 SWA 的 `Cache-Control`，不重复覆盖
- 私有本地数据统一由授权 owner/generation 生命周期管理：照片列表、媒体、重要片段统计、诊断和近期公开分享链接在注销/401/切号/角色变化时清理，旧版无归属 moments/share-link 键 fail-closed 删除；应用壳和 `app-code-v1`、界面偏好以及已带 workspace context 的文件夹路径不清理
- 已认证刷新会先完成账号绑定的上次群组选择恢复，再读取对应授权范围的照片缓存并刷新列表；同一工作区 5 分钟内返回或 focus 不重复拉取/解码全量列表，进行中的请求也不会被 focus 重启。时间线和文件夹网格只允许 `_th_`/preview derivative，旧缓存缺少衍生图时显示本地占位，不得隐式请求原图。原图仅由显式查看器或下载操作触发。服务端 cursor pagination 需在照片缓存、MemoryMap 与统计消费方完整迁移后单独实施，本次不做不完整的半分页。

---

## PWA 安装指南

### 桌面端（Chrome / Edge）

1. 通过 HTTPS 打开生产站点
2. 点击地址栏安装图标（或浏览器菜单 → 安装应用）
3. 从桌面/开始菜单作为独立应用窗口启动

### Android（Chrome）

1. 通过 HTTPS 打开生产站点
2. 浏览器菜单 → 安装应用 / 添加到主屏幕

### iOS（Safari）

1. 在 Safari 中打开生产站点
2. 点击分享
3. 选择「添加到主屏幕」

> iOS 不触发 `beforeinstallprompt`，因此应用内安装按钮在 iOS 上可能不显示。

---

## 项目亮点（简历版）

详见 [HIGHLIGHTS.md](doc/HIGHLIGHTS.md)

---

## 更新日志

详见 [CHANGELOG.md](doc/CHANGELOG.md)
