# 更新日志

### 2026-08-11 — 恢复历史照片位置

**紧急修复**
- **📍 历史位置重新进入图库与地图** — `/photos` 在当前授权空间内一次性读取 Cosmos 位置索引，为 Blob metadata 完全缺少 GPS 的旧照片补齐合法坐标；当前 Blob GPS 优先，来源 ETag 不匹配、跨空间、孤儿、重复、单边、非有限与越界行全部拒绝
- **🗺️ Cosmos-only 地图兼容** — 当前照片没有 list GPS 时，记忆地图重新接受同名合法 Cosmos 行，并通过当前/来源 Blob ETag 阻止 stale raw 索引绕过列表校验；有位置/无位置集合保持互斥且闭合，旧照片列表缓存通过 schema v2 路径确定性失效

---

### 2026-08-11 — 完善照片卡原生按钮与禁用态

**体验修复**
- **⌨️ 照片卡有效语义与统一菜单键盘模型** — 共享 PhotoCard 主按钮内部改为有效 phrasing content，保持整卡原生 Enter/Space 与现有布局；操作菜单复用 shared menuKeyboard，Tab 关闭后继续浏览器焦点顺序，Escape 与 action 仍只向 connected 主按钮恢复
- **🎞️ GIF 禁用态隔离** — 批量选择或 interactionDisabled 时隐藏并防御性阻止播放/暂停控制，已播放 GIF 立即切回 derivative-only 静态封面；删除 alertdialog、安全原图打开、44×44 兄弟操作、视频封面修复、拖放和 Header 安装入口保持不变

---

### 2026-08-11 — 清理前端部署运行时告警

**工程修复**
- **🚦 前端部署 Action 契约** — 移除 SWA upload 不生效的 `production_branch` 输入，生产仍只由 `main` hard condition 选择；同 workflow 的 `frontend-dist` 跨 job 传递升级到 Node 24 的 `upload-artifact@v7` / `download-artifact@v8`，名称、路径、1 天保留期、OIDC token、并发与 deployed SHA 健康检查保持不变
- **🧾 前端部署所有权与幂等 receipt** — production 在取 token 前、upload 前和 upload 后确认触发 SHA 仍是远端 main tip，并拒绝同 workflow/同 SHA或同 run 早期 attempt 已有成功 receipt 的重复上传；post-upload 失去 ownership 时不写 canonical receipt并重排当前 main。Health 只为 actual Azure upload+receipt 产生部署 verdict，coalesced success 不再取消或伪造第二条生产检查

---

### 2026-08-11 — 新上传照片位置闭环

**Bug 修复**
- **📍 新上传 JPEG/HEIC 位置立即可见** — 浏览器空 MIME、`application/octet-stream` 和非标准 JPEG/HEIC MIME 通过有界签名/扩展名识别；客户端坐标不完整、NaN 或越界时服务端回退 EXIF。合法 GPS 写入 Blob metadata、同步 Cosmos、合并到同名 React 照片并显式刷新记忆地图；地址服务失败显示“地址暂不可用”，不再伪装成无 GPS 或回显坐标
- **🧭 位置分类闭合** — 时间线计数、无位置筛选和地图统一使用 finite/range 坐标对；单边、NaN、Infinity、越界和缺失值进入互斥的无位置分区。地图丢弃旧 Cosmos 交集与孤儿索引，合法照片在索引缺失或非法时回退自身 GPS，用户可见有/无位置总数保持闭合
- **🗺️ 照片详情地图链接有效性** — 时间线与文件夹详情共用 finite/range 坐标 helper，并从规范化数值生成 Google Maps 链接；单边、NaN、Infinity 或越界值只显示缺失位置与编辑入口
- **🧪 iPhone HEIC 行为证据** — 生成式 JPEG/HEIC fixture 同时验证当前 `exifr` 的浏览器 `File` 与服务端 `Buffer` 读取路径，避免仅按格式名推断支持

---

### 2026-08-11 — 统一生产 HSTS 与入口文档

**安全修复**
- **🔒 Canonical HSTS** — SWA 与 Nginx 模板统一为 `max-age=31536000; includeSubDomains; preload`；前端代理隐藏上游重复安全头，static/security 契约锁定模板，smoke 要求 SWA 唯一 canonical 且代理首值 canonical
- **🌐 DNS 入口真实性** — 文档按权威 DNS 实测区分当前 apex/www 入口与尚未配置的 cn/global/智能 DNS，避免把 NXDOMAIN 主机声明为已上线
- **🎯 Production Health 部署身份** — `workflow_run` checkout、分类、报告与线上 guard 统一绑定 triggering deployment `head_sha`，jobs 分类同时固定到该事件的 `run_attempt`；前端 artifact 发布 no-store SHA marker，主域和 SWA 必须精确匹配，避免 main 已前移或同 run 重跑时混用状态造成假绿/假红
- **🩺 Production Health 工作流身份** — 前后端部署改用稳定 workflow 文件路径识别，不再依赖会被自定义运行标题覆盖的 `workflow_run.name`；手动 production、validation、并发分组和 SHA marker 检查保持一致
- **🔒 重要片段本地数据授权隔离** — 离线浏览统计和诊断按账号、角色与个人/群组工作区隔离；注销、401、切号或角色变化会同步清理私有照片、媒体和 moments，旧版无归属全局键不迁移给当前用户，应用代码缓存保留
- **🔒 近期分享链接账号隔离** — 浏览器保存的近期公开链接按账号与角色分区；注销、会话失效、切号或角色变化立即清理，迟到分享响应不能写回，旧全局键与损坏/超限 JSON 不迁移给当前用户
- **🔒 私有媒体过期索引清理** — 注销与授权范围变化会定向删除 Workbox expiration 中仅属于照片媒体/列表缓存的记录，并在活动写入结束后幂等重扫；应用代码元数据、预缓存和 service worker 注册保持不变
- **🔗 分享成功与本地记录解耦** — 公开链接创建成功后，本地配额、隐私模式或权限错误不再误报整个分享失败；链接继续显示/复制并提示“未保存到最近记录”，非幂等创建不会因 401 恢复或线路回退重试
- **🔒 私有本地键标准枚举** — 注销与授权切换按 `Storage.length/key()` 快照删除私有键，不再依赖不同浏览器对 Storage 对象属性的枚举差异

**体验修复**
- **⌨️ 移动侧栏 modal 隔离** — 关闭侧栏不再进入 Tab 顺序或辅助技术树；打开后提供标题、初始焦点、动态 Tab 循环、Escape/背景关闭与真实 FAB 回焦，叠加设置弹窗时只暴露顶层
- **⌨️ 自动隐藏导航焦点可见性** — Header 与页签在 Tab/Shift+Tab、方向键或 Home/End 到达时立即恢复到视口；导航聚焦、菜单/侧栏或任意模态层活跃期间不再被滚动隐藏，移动端仅在页签条内 nearest 滚动
- **📍 位置搜索键盘与请求隔离** — 搜索输入、坐标预览和地点结果补齐标签、44px 原生按钮、方向键/Enter/Escape 与 polite 状态播报；清空、关闭、卸载或切换工作区会中止并推进请求 generation，旧响应不再覆盖新输入或 loading
- **🔎 工作区页签浅色对比度** — 六视图文字、数量徽章和键盘焦点环分别满足普通文本 4.5:1 与相邻背景 3:1；选中态同时使用粗体、底边和底纹，不只依赖颜色
- **⌨️ 跳到当前主要内容** — 已登录页面首个键盘入口动态指向当前工作区面板，聚焦时才显示；可跳过 Header/页签，侧栏或模态层打开时不暴露后台入口，窄屏不产生布局位移或横向溢出
- **⌨️ 照片操作菜单键盘闭环** — 普通模式照片主按钮可用 Shift+F10 / 菜单键打开具名菜单，支持方向键、Home/End、Enter/Space、Escape、外部点击、视口内定位和 connected-only 焦点恢复
- **🗑️ 照片删除确认键盘边界** — 直接删除和操作菜单共用具名 alertdialog；默认聚焦取消并约束 Tab，Escape/外部关闭后恢复正确入口，删除请求进行中禁用操作并拒绝提前关闭或重复提交
- **◐ 照片与文件夹卡片对比度** — 文件名、日期、照片计数和新建入口达到至少 4.5:1；操作字形、hover/selected、选择边界和键盘焦点达到至少 3:1，同时保持 44×44 命中区与现有键盘/触控行为
- **🎵 胶囊与故事媒体类型修正** — 音频缩略图改为零网络本地占位，胶囊仍可选择音频；自动故事只统计和播放图片及已有派生封面的视频，排除音频、未知类型和无封面视频
- **💌 时光胶囊存储恢复** — 本地胶囊按用户与空间隔离，旧数据只迁入个人空间；损坏 JSON、非法日期、重复 ID、越界记录和 URL/SAS 名称会安全丢弃，读写/配额失败显式提示且不会显示伪成功

---

### 2026-08-11 — 旧客户端跨部署资产恢复

**Bug 修复**
- **🛟 旧 Service Worker 不再因已删除 hashed 资源瘫痪** — 生产部署按 SHA-256 保留最多 24 代、64 MiB 的历史 JS/CSS；首次启用 manifest 时还会从固定 HTML pin 同源递归抓取发布瞬间当前生产代的完整 lazy JS/CSS，避免迁移本身制造新的旧壳断链。旧 app shell 和 PWA 新标签可继续加载精确资源，缺失 JS/CSS 保持 404 JSON 而非 SPA HTML。安全撤销、完整代次淘汰、危险操作零自动刷新、双标签 waiting worker 与 standalone 均有 hermetic/真实浏览器契约，已登录 Header 顶部安装入口保持删除

---

### 2026-08-10 — 可靠性、无障碍与媒体恢复

**Bug 修复**
- **⌨️ 自动隐藏 Header 焦点可见性** — 空间或头像触发器接收焦点、任一 Header 菜单打开、或菜单发起的弹窗活跃时立即显示并锁定 Header；弹窗关闭后仅向仍连接且可见的触发器恢复焦点，Tab 离开 Header 后才允许后续滚动再次隐藏
- **📍 历史照片位置安全恢复** — 地点地址改由鉴权反向地理编码代理、有界缓存和空间隔离恢复；历史 NaN、越界、单边或缺失 GPS 会先只读估算，再按 MIME/Range、每页 8 MiB 预算和请求截止时间恢复。合法位置不下载原图，不完整扫描不清理或写完成标记
- **⌨️ Header 菜单与嵌套弹窗** — 空间切换、用户菜单及群组/安装/快捷键/管理员弹窗补齐 menu/dialog 语义、方向键、Home/End、动态焦点循环、嵌套隔离和 connected-only 焦点恢复；pending 操作仍受关闭保护
- **⚡ 时光胶囊与自动故事减载** — 胶囊照片区首批挂载 18 张、内部滚动每次追加 12 张并保留完整选择；自动故事无论 215+ 照片都只渲染一个原生 range scrubber，支持 Arrow/Home/End、点击、拖动及自动播放同步，并清理 200ms 过渡任务
- **🖼️ 文件夹与照片卡片可访问操作** — 文件夹打开、重命名、删除和照片主操作改为独立原生按钮；触控目标至少 44×44，Enter/Space、`aria-pressed`、完整可访问名称、focus ring、拖放、右键和批量守卫保持一致
- **📱 移动端快捷操作与日期** — 320–480px 默认折叠 FAB，200% 缩放下展开不越界并在操作、外部点按或 Escape 后收起；时间线、卡片和详情统一使用安全的 zh-CN 日期格式，日期控件与主要操作保持至少 44px
- **🗺️ 记忆地图键盘与触控访问** — 标记保留 22px 视觉锚点但真实命中区扩为 44×44，使用照片名语义并支持 Tab/Enter/Space；详情与 GPS 编辑具备 stacked dialog 焦点边界、pending 关闭保护、迟到保存隔离和严格坐标校验
- **⬆️ 失败上传进度真实性** — 413、部分网络失败和取消只保留实际上传字节，不再补成整文件或制造速度尖峰；重试/线路回退使用独立单调线传输计数采样速度，混合批次在照片库刷新期间保持守卫并明确显示成功/失败/取消结果，旧暂停状态不再遮住 settle 状态
- **🚦 前端生产部署竞态** — 同一 production target 的 main push 与显式 production 手动运行不会再并发进入 Azure SWA；运行中的 upload 保留，额外 pending 在进入 Azure 前 coalesce，不再产生 Deployment Canceled failure。当前 workflow 中 PR 与非 main 手动运行固定为 validation-only，production token 由 main job 通过 OIDC 即时读取且不引用 repository token；删除旧 secret 是隔离历史分支 workflow 的运维前提
- **🔄 跨部署 lazy chunk 404 自恢复** — 旧页面在新版本发布后请求已删除的 hashed chunk 时，安全会话最多自动刷新一次；上传、下载、语音、批量、回收站、维护和文件夹重命名期间保持 0 次刷新并在完成后恢复。文件夹/地图等 lazy panel 使用独立边界，失败不再瘫痪整个主区，用户界面不再暴露模块 URL 或技术错误
- **📱 横向抖动与底部遮挡** — 320/390px 的本周概况保持 full-bleed 但不再扩大根文档，Tab 导航仍可自身横向滑动；≤360px 悬浮操作默认收纳为 48px 单入口，按需展开全部动作并支持 safe-area、Escape、焦点回归与 ARIA 状态
- **🧰 侧栏筛选、中文日期与移动触控遮挡** — 时间线侧栏改用显式容器级布局：搜索/清空与快捷筛选分组，筛选 chip 和网格尺寸按可用宽度重排；320–480px、200% 缩放和长中英文标签下保持完整可见、无横向滚动及 44px 触控目标，真实 320px 视口的 262px 抽屉已量化确认筛选行为 224/224px 且控件均在内容边界内。侧栏现在以 dialog 管理初始焦点、Tab 闭环和入口恢复。筛选器、拍摄时间编辑和时光胶囊统一使用认证界面的原生控件字体、字号与高度，日期数字等宽且继续保留系统 picker/`YYYY-MM-DD` 值；胶囊默认、最小和创建日期使用本地日历 key，跨 UTC 日界线也不会提前或延后一天。时间线分组、照片卡片和时间线/文件夹查看器改用单一显式 `zh-CN` helper，非中文浏览器和西时区也稳定显示正确中文日期，无效日期安全回退。390px 触屏仅扩大照片收藏/删除和头像命中区到 44×44px，并补充非重叠命中与可见焦点环；320/360px 文件夹网格改为单列，避免 44px 动作被窄卡片裁切。WorkspaceFab compact breakpoint 扩至 480px，默认仅显示 48px launcher，展开保持视口内，动作执行前把返回焦点交给可见 launcher 后再收起，避免新模态界面捕获隐藏按钮。其他紧凑控件维持原密度，宽桌面布局不变
- **📲 PWA capability 告警** — 保留 Apple meta 并补充标准 `mobile-web-app-capable=yes`，源码、构建产物和线上 smoke 共同校验

**体验优化**
- **⌨️ 工作区六视图页签导航** — 六个主视图补齐具名 tablist/tab/tabpanel、稳定关联 ID、roving tabindex、Arrow/Home/End 自动激活和窄屏 nearest 滚动；传输、mutation 或模态边界拒绝切换时，当前 selected 与焦点不漂移，隐藏 panel 的恢复 UI 也不会泄漏到当前视图

---

### v1.9.0 — Algorithm Package · 流量优化深化 · 下载体验重构

**Bug 修复**
- **🎬 视频播放中途黑屏/无限加载** — 时间线与文件夹查看器复用同一恢复控制器；同源代理用 2-byte Range/206 探测，跨域 Blob 交给 no-CORS 媒体播放验证。播放态连续 4 秒无时间进展才有限换线，`readyState=4` 不会掩盖停滞，并在新线路 metadata 后恢复原位置、播放意图、静音、音量与倍速。direct 不尝试 tainted canvas 截帧；暂停、seek、后台、结束和旧 viewer 事件不会误切，双线路失败会结束 spinner 并提供原位重试。低信息但物理存在的封面会进入账号/工作区隔离的 registry；超过 48 MiB 被动修复上限的视频在用户主动播放后复用现有 viewer 的非零、非低信息代理帧修复，不增加第二个媒体请求，成功后立即同步全部图库入口
- **🎬 移动后视频封面与播放卡顿** — 移动过目录的视频会从同一次授权范围 Blob listing 中恢复仍然存在的历史封面，当前位置的标准 derivative 始终优先，且不增加逐项 HEAD 或原视频下载；打开视频时跳过下载票据预取并使用 `preload=auto`，首帧解码后立即补存缺失封面，同时原视频不再进入 Service Worker 的 CacheFirst 缓存
- **🎬 视频封面缺失与播放中途重载** — 普通列表会直接识别同一次 Blob listing 中实际存在的 `_th_{original}.webp` / `_th_{original}-prev.webp`，不再依赖 original metadata；视频详情按每次 View 冻结 source 与稳定 key，线路探测、封面回写和列表刷新只更新 poster/grid，不重建播放器。仅当前 source 明确失败且尚未加载可播放帧时允许一次原元素 fallback，缺少 derivative 的网格仍保持 0 个原视频请求

**新功能**
- **⬆️ 网络感知有界上传与内存背压** — 4G 小图最多 3 并发、未知/3G 最多 2 并发，视频按权重 2 调度；暂停只冻结新任务，进度聚合所有活跃 XHR。服务端在正文前快速拒绝超限声明，并以单实例 256 MiB / 单用户 220 MiB lease 保护缓冲与派生图；繁忙返回可重试 429，下载仍为 Blob SAS 直连
- **🧮 `packages/algorithm` 算法包** — 新增 monorepo 内部包 `@cloudphoto/algorithm`，集中沉淀所有优化算法与魔法常量：`bandwidth.ts`（Range Request 策略）、`priority.ts`（照片重要性评分）、`pagination.ts`（分页配置）、`render.ts`（查看器分级阈值）、`media.ts`（THUMBNAIL_MIME、BLANK_GIF、WebP 质量）；前端通过 Vite alias + TypeScript paths 直接引用源码，Vite tree-shake 后 bundle 不增大

**流量优化**
- **📡 HTTP Range Request 截帧**（`VIDEO_THUMB_RANGE_BYTES = 524 287`）— 视频封面提取改为只下载前 512 KB（faststart MP4 moov 原子范围），下载量从 10-200 MB → **最多 512 KB**（-99%+）；非 faststart 视频自动回退全量
- **📹 视频封面一次生成永久复用** — 首次截帧后自动调用 `setVideoThumbnail` 持久化到服务器，后续 gallery 加载走 `<img>` 快速路径，不再触发视频下载
- **🎞️ GIF 服务端首帧缩略图** — sharp 为 GIF 生成静态首帧 WebP；gallery 卡片先显示缩略图，后台异步预加载完整动图，加载完成无缝切换

**下载体验**
- **⬇️ 原生浏览器下载，零 JS 内存** — 服务端 download 端点改为生成含 `Content-Disposition: attachment` 的短时 SAS URL（~100ms），客户端用 `<a>` 触发原生下载；文件不过 JS heap，用户点击后立即可离开页面；服务器内存占用：**0 bytes**（原：整个文件大小）

**工程优化**
- **分页规模调整** — `DEFAULT_PAGE_SIZE: 40 → 24`，首屏请求数减少 40%，与常见 2/3/4/6 列网格对齐
- **前端服务层分域拆分** — `photoApi.ts` 拆为 `http` / `authApi` / `uploadApi` / `shareApi` 四个职责单一模块

---

### v1.8.0 — 服务层重构 · 性能优化 · Tab 缓存 · 动图修复

**Bug 修复**
- **🎞️ 动图在 Vivo / Android 上无法播放** — 移除 `isAnimated` 和 `isMotionPhoto` 路径上的 `loading="lazy"` 与 `decoding="async"`；部分 Android WebView 异步解码导致 GIF 只渲染第一帧，Funtouch OS 在 `opacity:0` 时不加载懒图
- **🖼️ 视频封面图 UI 卡在 loading 状态** — 移除 `useVideoThumb` 路径的 `loading="lazy"`；添加 `videoThumbImgRef` + `useEffect` 处理 `img.complete` 竞态（图片在 React 绑定 onLoad 前从缓存完成加载）
- **🎬 动态视频返回 404** — `motionVideo.ts` 函数从未被 `server/src/index.ts` 导入，补全 `import "./functions/photos/motionVideo"`

**新功能 / 优化**
- **⚡ Tab 切换缓存** — 时间线、瞬间、文件夹三个主要 Tab 改为 `display:none` 隐藏而非卸载，切换回来不再重新加载缩略图；移除 `key={activeTab}` 避免 ErrorBoundary 重置整棵树
- **🏗️ 前端服务层拆分** — `photoApi.ts`（899 行 God File）拆分为四个职责单一的模块：`http.ts`（HTTP 工具）、`authApi.ts`（认证）、`uploadApi.ts`（上传）、`shareApi.ts`（分享链接）；`photoApi.ts` 保留为兼容性 barrel，所有现有 import 无需修改
- **📁 目录整理** — `features/share/` → `services/share/`；`scripts/migrate-photo-locations.mjs` → `scripts/migrations/`

---

- **⭐ 重要片段最多展示 Top 20** — 重要片段视图按评分排序后固定只展示前 20 张，提升加载速度与准确性；「加载更多」按钮在此模式下隐藏

### v1.7.0 — EXIF 时区修复 · 排序方式切换 · 历史回填 · 批量编辑

**Bug 修复**
- **🕐 拍摄时间时区修复** — exifr 将 EXIF 日期时间内部视为 UTC，导致 UTC+8 用户显示偏差 8 小时；`uploadPhoto.ts` 和照片弹窗的「修改拍摄时间」均改为不带 Z 后缀的 naive datetime 存储，客户端按本地时间正确解析
- **🎞️ 动图暂停/恢复跨域修复** — 原实现用 `<canvas>` 截帧检测，Azure SAS 跨域时抛出 SecurityError；改为 BLANK_GIF（1×1 透明 GIF Data URL）src 替换方案，暂停时显示半透明遮罩，恢复时 GIF 从第 0 帧重播
- **🖼️ 动图弹窗可点击预览** — 照片弹窗中动态图 `<img>` 缺少 `onClick` 且 `cursor` 为 `default`；现已加上点击回调并改为 `cursor: zoom-in`

**新功能**
- **📷 / ☁ 排序方式切换** — 时间线工具栏新增「📷 拍摄时间」与「☁ 上传时间」切换按钮；`PhotoGallery` 新增 `sortKey` prop，`groupByDate` 和 `flatPhotos` 均尊重该字段，无拍摄时间时自动回退到上传时间
- **📦 历史照片元数据回填** — 设置 → 应用 新增「历史照片回填」：新增 `POST /api/photos/backfill` 端点，逐一下载缺少 `takenAt` 或 `gpsLat` 的 blob，用 exifr 提取 EXIF 并写回元数据 + Cosmos；设置页显示扫描/更新/失败统计
- **⏱️ 批量修改拍摄时间** — 批量选择模式新增「修改时间」按钮，展开 `datetime-local` 选择器，一键为选中照片统一设置拍摄时间
- **📍 批量修改位置** — 批量选择模式新增「修改位置」按钮，展开纬度/经度输入框，一键为选中照片统一更新 GPS 坐标；新增 `onGpsUpdate` 回调同步 App 内存状态

### v1.6.1 — 界面优化 · 视频封面 · 服务端重构

**界面修复**
- **⬆️ 返回顶部按钮位置稳定** — 按钮移至左下角，与右侧 WorkspaceFab 永不冲突；`bottom` 改用 `env(safe-area-inset-bottom)` 计算
- **🎞️ 重要片段视频封面** — Moments / TrashView / TimeCapsule 统一使用 `MediaThumb` 组件，视频自动定位代表帧，右下角显示 ▶ 标识
- **WhatsNew 自动淡出修复** — 改用 keyframe 动画替代失效的 transition，4s 淡出正常工作
- **Tab bar 垂直居中** — shell-wrap 上下 padding 对称
- **照片详情弹窗水平居中** — 打开弹窗时锁定 body scroll 并补偿滚动条宽度

**服务端重构**
- **`utils/` 按领域拆分** — `blob/`、`cosmos/`、`email/`、`auth/` 子目录；全部 35 个 function 文件的 import 路径同步更新

### v1.6.0 — 历史上的今天 · 记忆地图 · 时光胶囊 · 自动故事

- **📅 历史上的今天** — 时间线顶部自动检测往年同月同日的照片，按年份分组显示缩略图卡片
- **🗺️ 记忆地图** — 上传含 GPS EXIF 的照片时自动提取坐标；地图（OpenStreetMap + Leaflet）以圆形照片图标标注拍摄地点
- **💌 时光胶囊** — 将任意照片封存并设置解锁日期；到期前倒计时，到期后自动解锁
- **🎬 自动故事** — 选择文件夹生成全屏幻灯片；支持淡入淡出/滑动/缩放三种过渡效果及 2–10 秒播放间隔
- **GPS 数据管道** — `uploadPhoto` 服务端接受 `gpsLat`/`gpsLon` 查询参数写入 blob 元数据

### v1.5.4 — 体验优化 · What's New 弹窗

- **What's New 弹窗** — 页面加载时若过去 3 天内有新功能，右下角弹出更新卡片，10 秒自动消失，已读记录存 `localStorage`
- **批量删除/清空回收站进度** — 批量删除及「清空回收站」显示实时进度条
- **删除确认弹窗居中** — 通过 `createPortal` 渲染到 `document.body`，始终视口居中
- **文件夹路径刷新持久化** — `FolderView` 从 `localStorage` 惰性初始化 `currentPath`
- **视频缩略图居中裁剪** — `object-fit: cover; object-position: center`，内容居中裁剪不显示边角
- **视频缩略图定位** — `loadedmetadata` 后 seek 到 `min(2, duration × 0.1)` 处

### v1.5.3 — 语音备注（F1）· 视频选择修复

- **F1 语音备注** — 录制、上传、播放、删除附加在照片上的语音备注；存储在内部 `_voice` 文件夹，通过 blob 元数据 `voiceMemoName` 关联；支持 `audio/webm`（Chrome/Android）和 `audio/mp4`（Safari/iOS）
- **视频文件选择修复** — `UploadArea` 和 `FolderView` 的文件输入框 `accept` 属性加入 `video/*`

### v1.5.2 — 视频上传 · 字节级进度 · 隐私提示 · 详情页重设计

- **隐私提示** — 可折叠分享面板在创建链接前显示 🔒 隐私提醒（身份证/银行卡等敏感信息）
- **视频上传** — 服务端接受 mp4/mov/webm/avi/mpeg/3gpp（最大 200 MB）；视频在缩略图卡片和详情弹窗中直接播放
- **字节级上传进度** — `XHR.upload.onprogress` 驱动进度条，显示 X.X / Y.Y MB
- **详情页重设计** — 桌面端照片占 68% 宽；操作按钮收敛为单行胶囊条（⬇ 下载 · ♡ 收藏 · 🔗 分享 · 📁 移动 · 🔍 预览 · 🗑 删除）
