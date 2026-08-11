# AI_REPRO_SPEC
2.72b 首轮当前生产代捕获契约：线上尚无 `deployment-assets.json` 且响应命中固定 HTML pin 时，发布脚本必须从 entry/modulepreload/style 开始，同源递归下载可达 hashed `.js`/`.css` 原始字节作为独立必需 bootstrap generation；不得只保留固定历史事故 CSS。只接受 200 `text/javascript|application/javascript|text/css`，拒绝跨域、非 hash、source map、HTML fallback、空内容、非法 UTF-8、超过 512 个资源或总 64 MiB。当前构建、当前生产捕获代与固定历史事故代任一无法完整装入预算时必须拒绝发布；hermetic contract 覆盖 HTML→entry→lazy→nested 闭包、原始字节 SHA-256、MIME fail-closed 和必需代预算拒绝。
20. 时间线排序切换（最新/最早）chip 可用
21. 键盘快捷键 1/2/3/S/Backspace 在非输入框状态均可正确触发
22. 周报卡片显示存储用量（非硬编码，基于实际 blob size 聚合）
23. 切换群组时时间线筛选自动清空
24. 视频上传：server 端接受 video/mp4、video/quicktime、video/webm、video/x-msvideo、video/mpeg、video/3gpp（最大 200 MB）；图片仍限 20 MB
25. 字节级上传进度：XHR.upload.onprogress 驱动进度条，显示 X.X / Y.Y MB 而非文件个数
26. 隐私分享提醒：分享面板内含 🔒 静态提示文本，提醒确认不含敏感信息
27. 详情页重设计：桌面端照片占 68% 宽；操作按钮收敛为单行胶囊条（下载/收藏/分享/移动/预览/删除）；分享区与移动区可折叠
2.18 时间线应提供排序切换 chip（最新/最早），通过前端状态控制，不需要额外 API
2.19 键盘快捷键应覆盖：R=刷新，1/2/3=切换 Tab，S=开关侧边栏，?=帮助面板，Esc=关闭弹层，Backspace=清筛选（均需跳过输入框焦点）
2.20 本周概况卡片应展示存储用量，计算方式为聚合所有照片的 blob size metadata 字段
2.21 切换群组/个人空间时必须自动清空所有时间线筛选条件
2.22 顶部标题栏在群组空间内应展示当前群组名称标识（pill badge）
2.23 Toast 通知必须提供手动关闭按鈕（✕），不应仅依赖自动超时
2.24 浮动胶囊入口在有激活筛选时应展示筛选数量 badge
2.25 视频 MIME 类型列表：video/mp4, video/quicktime, video/webm, video/x-msvideo, video/mpeg, video/3gpp, video/3gpp2；图片限 20 MB，视频限 200 MB
2.26 uploadPhotoWithProgress 使用 XMLHttpRequest + upload.addEventListener('progress') 实现字节级回调；uploadProgress state 字段为 bytesLoaded/bytesTotal/filesDone/filesTotal
2.27 分享面板使用 showSharePanel 布尔状态切换，默认收起；面板内含 modal-privacy-notice 元素
2.28 PhotoCard.tsx 与 MediaThumb.tsx 中视频网格只能使用已持久化的 thumbnail/preview `<img>`，缺失时显示本地 placeholder，不得挂载原始 `<video>`；右下角显示 photo-video-badge (.▶)。用户明确打开视频查看器后才挂载 `preload="auto"` 的播放器，由浏览器按 Range 获取起播数据。
2.29 文件夹路径刷新持久化：FolderView 使用惰性 useState 初始器从 localStorage 直接读取 currentPath 和 extraFolders，确保刷新页面后立即回到上次所在文件夹，而不是重置到根目录；persist effect 使用 hydratedContextRef 防止首次渲染覆盖
2.30 删除确认弹窗必须通过 createPortal(…, document.body) 渲染，避免受父元素 transform/overflow 影响导致 position:fixed 偏移出视口
2.31 批量删除与清空回收站进度：AuthenticatedApp.tsx 中新增 deleteProgress state（done/total/label）；handleBatchDeleteWithProgress 顺序调用 deletePhoto 并逐步更新进度；transferring 条件包含 deleteProgress !== null；transfer-banner 新增 deleteProgress 分支（🗑️ 图标 + 百分比 + 进度轨道）；TrashView 内部有独立 emptyProgress state，渲染 .trash-empty-progress 内联进度块（复用 transfer-banner-* CSS 类）；清空过程中"清空回收站"和"全部恢复"按钮 disabled
2.32 WhatsNewPopup：`packages/client/src/components/whats-new/WhatsNewPopup.tsx`；CHANGELOG 数组含 id/date/icon/title/desc 字段；getRecentEntries() 过滤 3 天内条目；localStorage key cf_whats_new_seen 存储最近已见日期；仅当有比已见日期更新的条目时展示；createPortal 渲染到 document.body；requestAnimationFrame 驱动倒计时进度条（100→0），AUTO_DISMISS_MS=10000；关闭后写入 latestDate 到 localStorage；新功能只需向 CHANGELOG 头部追加条目
2.33 详情弹窗移动端垂直居中：media query 内 .modal-content 使用 margin: auto（替代 margin: 0）；max-height 改为 none；overlay 保持 align-items: flex-start + overflow-y: auto，实现"有空间时居中、超高时从顶部滚动"的标准 flex 模式
2.34 视频缩略图居中裁剪：.photo-thumbnail video 与 img 共用同一规则块，均设置 width:100%; height:100%; object-fit:cover; object-position:center；hover 缩放同步适用于 video 元素
2.35 历史上的今天（OnThisDayCard）：`packages/client/src/components/on-this-day/OnThisDayCard.tsx`；Props: photos: Photo[], onJumpToPhoto?: (name: string) => void；过滤 photos 中月日与今天一致且年份小于当年的照片；按年分组，显示缩略图 + 「X年前」标签；默认展示前 6 张，「+N」按钮展开；整体渲染在 AuthenticatedApp.tsx 时间线分支的 PhotoGallery 上方；CSS 前缀 .otd-*
2.36 记忆地图（MemoryMap）：`packages/client/src/components/memory-map/MemoryMap.tsx`；lazy 加载（dynamic import）；使用 leaflet 直接操作（非 react-leaflet）；在 useEffect 中 import("leaflet").then(L => ...) 初始化地图；OpenStreetMap tiles；markers 为 L.divIcon（含照片缩略图，class map-photo-marker）；点击 marker 底部弹出详情面板（.memory-map-detail）；Props: photos: Photo[], onViewPhoto?: (name: string) => void。Tab 计数、地图标记和无位置列表必须共用 `classifyGpsCoordinates` 的 atomic finite/range pair，`0` 合法；诊断严格分为 both-finite、latitude-only、longitude-only、neither-or-invalid 四类。地图只使用当前照片与合法 Cosmos location 的交集：当前照片完全没有 list GPS 字段时允许采用合法 Cosmos-only 历史位置；带 `sourceBlobEtag` 的行必须匹配 `/photos` 返回的当前 `blobEtag`，当前照片已有合法 GPS 时只接受匹配索引并在冲突时回退当前 GPS；单边/非法当前 GPS、重复/非法 Cosmos、跨空间行与没有当前照片的孤儿索引必须丢弃。有位置与无位置集合互斥且数量之和等于当前照片总数。新增 ViewTab: "map"；CSS 前缀 .memory-map-* .map-photo-marker
2.37 时光胶囊（TimeCapsule）：`packages/client/src/components/time-capsule/TimeCapsule.tsx`；lazy 加载；存储通过 `capsuleStorage.ts` 使用 `cf_capsules_v2_<encoded userId>_<encoded workspaceKey>`，legacy `cf_capsules_<userId>` 只迁移到 personal；capsule 结构: { id, title, photoNames, unlockDate, createdAt }；锁定/解锁分区；创建弹窗使用 createPortal。照片选择区自身是 IntersectionObserver scroll root，首批只挂载 18 个记忆项、每次追加 12 个；同一 mounted workspace 内切换 folderFilter、照片来源或重开弹窗时窗口和内部 scrollTop 回到首批，但完整 selectedNames Set、计数和提交结果不因窗口裁剪丢失。切换 workspace 会由 keyed boundary 重挂 TimeCapsule，并从该空间的空选择状态开始，不得宣称跨空间保留未提交选择。视频只能使用静态派生封面，audio 使用零网络本地占位，均不得被动请求原媒体或启动历史封面 repair。新增 ViewTab: "capsule"；CSS 前缀 .capsule-*
2.38 自动故事（AutoStory）：`packages/client/src/components/auto-story/AutoStory.tsx`；lazy 加载；来源、文件夹、空态、计数和播放器只能纳入图片及已有 thumbnail/preview 的视频，排除 audio、未知类型和无派生封面视频；选择文件夹/全部 + 过渡效果(fade/slide/zoom) + 播放间隔(2-10s)；全屏播放器通过 createPortal；背景为当前图片的 blur 大图。无论 215 张或更多可故事化媒体，进度 UI 都只能挂载一个原生 `input[type=range]` scrubber，不得恢复逐项节点；scrubber 支持原生 Arrow/Home/End、点击和拖动，并通过 currentIndex 与自动播放、前后切换和计数双向同步。非 scrubber 焦点下保留 ←/→ 导航与 Esc 退出；关闭、卸载、直接跳转或快速连续导航必须清除旧 200ms 过渡 timer，迟到任务不得覆盖当前 index。播放器只使用派生图，不下载 original。新增 ViewTab: "story"；CSS 前缀 .story-*；@keyframes story-fade-in/story-slide-in/story-zoom-in
2.39 GPS 数据管道：客户端不得只凭 `File.type.startsWith("image/")` 决定是否读取 EXIF；空 MIME、`application/octet-stream`、`binary/octet-stream`、JPEG/HEIC 非标准 MIME 必须通过最多 64 字节签名或已知扩展名识别，再用 `exifr.gps(file)` 提取完整、finite、纬度 ±90°/经度 ±180° 内的 pair，并作为 gpsLat/gpsLon 查询参数传给 uploadPhoto。服务端 legacy upload 必须独立规范 MIME；客户端 pair 缺失、单边、NaN、Infinity 或越界时必须先调用服务端 TIFF/HEIC `exifr.gps(buf)` fallback，未得到合法 pair 时再从同一已受图片上传上限约束的正文显式解析标准 Adobe/Microsoft XMP `exif:GPSLatitude/GPSLongitude`，必须覆盖单段与 Extended XMP，支持数值或度/分/可选秒、方向后缀或 ref，并执行相同原子范围校验；partial、malformed、non-finite、方向冲突或越界 XMP 不能写 metadata。同步 `photoLocations` 后上传响应和 listPhotos 都携带 gpsLat/gpsLon；`listPhotos` 必须在 Blob 枚举后只执行一次当前 personal/group 授权 scope 的 Cosmos 查询，并只为 Blob metadata 完全没有 GPS 键的照片补齐合法 pair，补充查询必须由 1.5 秒真实 wall-clock timer 与 SDK AbortSignal 共同限界，即使 SDK retry sleep 忽略取消也必须及时拒绝并由列表 handler 非致命降级。位置行只接受非空 `name` 或历史 `photoName`；两者同时存在且不同必须拒绝，任何别名都不得授权跨 scope 或孤儿行。带 `sourceBlobEtag` 的行必须与当前 listed Blob ETag 完全匹配，无该字段的 legacy 行保持兼容；只要当前照片存在任何 versioned 行，就只能由精确匹配当前 ETag 的 versioned 行补齐，stale、malformed 或冲突别名的 versioned 行不得回退到 legacy。跨 scope、孤儿、重复、单边、non-finite、越界、来源 ETag 不匹配和当前 Blob 已有合法/非法/单边 GPS 键的行不得注入列表。`/photos` 必须返回当前 `blobEtag` 与显式 `gpsMetadataPresent`，`/photos/locations` 必须投影 `scope`、`name`、`photoName` 与 `sourceBlobEtag`；客户端只有在 `gpsMetadataPresent === false` 时才允许 Cosmos-only fallback，并在 duplicate/fence/hydration 前要求 Cosmos scope 与当前照片路径派生 scope 完全一致，再执行相同的标识、歧义与 freshness gate。旧后端或无法证明 metadata 完全缺失或无法提供真实 scope 的 payload 必须 fail closed。若索引行不存在或被上述 gate 拒绝，记忆地图可把当前 list 中 `gpsMetadataPresent === false` 且具有 Blob ETag 的 noGps 照片按最多 64 张一批送入 `POST /photos/locations/recover`；服务端必须在任何 Blob 读取前一次性验证 personal/group/admin workspace，逐项要求当前 ETag `If-Match`，只读解析 TIFF/HEIC、标准或 Extended XMP GPS，并受顺序扫描、8 MiB 总 Range 预算、认证后从 group membership 与 96 KiB Content-Length 门禁开始的 2.5 秒真实 wall-clock deadline，以及单会话 512 张、64 请求和 128 MiB 总读取上限约束。该路径不得写 Blob metadata、Cosmos、scan version 或触发 backfill；因此只有该精确 POST 可在 token refresh 或 retryable route failure 后串行重放，仍不得 hedge，并须顺序扫描大图以保证共享预算下每批至少有界推进；present-but-invalid/partial metadata 继续 fail closed。响应坐标必须携带 `sourceBlobEtag`，客户端只把同名、finite/range 且精确匹配当前照片 ETag 的结果叠加为 `gpsMetadataPresent:true` 的当前 Blob 权威坐标；预算/超时未处理项可只读重试，stale、orphan 或跨 scope 结果不能进入分区。持久化照片列表 cache key 必须带 schema version，使升级后的 Gallery/Folder 不会恢复缺少该 hydration 的旧 payload。同名客户端对象必须合并新响应中的 GPS、takenAt、最新 SAS、thumbnailUrl 和 previewUrl，不得保留无 GPS 旧对象。
2.40 EXIF 拍摄时间时区：exifr 内部将 EXIF 日期时间视为 UTC，因此使用 getUTCFullYear/Month/Date/Hours/Minutes/Seconds 格式化为不含 Z 后缀的 naive datetime 字符串（如 "2024-05-20T14:30:00"）；客户端 new Date("2024-05-20T14:30:00") 按本地时区解析，UTC+8 用户显示 14:30 而非 22:30
2.41 排序键切换（takenAt / uploadedAt）：PhotoGallery 新增 sortKey prop（"taken" | "uploaded"，默认 "taken"）；groupByDate 和 flatPhotos useMemo 均按 sortKey 选择日期字段——"taken" 使用 photo.takenAt ?? photo.createdAt ?? photo.lastModified，"uploaded" 使用 photo.createdAt ?? photo.lastModified；AuthenticatedApp.tsx 新增 photoSortKey state，工具栏新增「📷 拍摄时间」和「☁ 上传时间」chip 切换按钮
2.42 历史照片元数据回填：`POST /api/photos/backfill?limit=30[&groupId=<id>&cursor=<opaque>&dryRun=true]`，limit 必填，缺失时返回 400；有效正整数最大 100，非法或非正值回退到 30。每次最多列出一个 Azure Blob 页并排除 derivative、删除项和非图片。`dryRun=true` 只读取 Blob properties/metadata，返回候选数与最大估算读取量，不下载原图或写数据；确认后的 live 扫描只把缺失/无效 GPS 且尚未完成当前 GPS scan version 的照片作为候选，执行 2.79 的有界 MIME/Range 恢复，并与上传共用 TIFF/HEIC + 标准/Extended XMP GPS reader。scan version 3 必须重新检查此前由 TIFF-only version 2 标记为无位置的原图；在同一候选缺少 takenAt 时顺带恢复拍摄时间，单独缺少 takenAt 不触发原图扫描。游标绑定 `metadata + personal user|group` 上下文，客户端 auth generation 或 workspace 变化后终止后续批次；Blob metadata 以 ETag 条件写回，随后单独把最新 GPS 状态对账到 photoLocations Cosmos，索引失败保持显式且可重试，不伪装跨存储原子事务。响应除 processed/updated/failed/hasMore/cursor 外还返回 candidates、estimatedBytes、bytesRead、recovered、cleanedInvalid、trulyMissing、skippedBudget 与 indexReconciled，客户端逐页聚合；SettingsDialog「📱 应用」Tab 展示只读估算、确认、停止、累计进度与结果。
2.42a 上传批次授权、空间与幂等：客户端在批次开始时捕获 auth generation、显示名和 groupId，订阅认证与当前空间变化并用同一 AbortSignal 终止当前 XHR、暂停/离线等待、重试和剩余文件；认证/空间变化或 AbortError 不进入三次网络重试，进度、照片追加、视频封面和最终刷新也校验原空间。每个文件在重试循环外生成一次 crypto.randomUUID() 作为 uploadId；服务端校验 UUID，以 `{scope}/{folder}/{uploadId}-{safeName}` 为稳定 Blob 名并用 ifNoneMatch=* 条件创建，412 或已存在时从当前 Blob 对账 GPS Cosmos 后返回同一 Blob；groupId 上传必须通过 isGroupMember。带 uploadId 的代理上传在网络错误、超时、缺失路由或网关错误时只直连补偿一次。
2.43 批量修改拍摄时间：PhotoGallery 批量模式工具栏新增「修改时间 (N)」按钮；展开内联 datetime-local 输入框；handleBatchSetTakenAt 遍历 selected 集合调用 updatePhotoTakenAt，使用本地时区 naive datetime（不调用 toISOString()）
2.44 批量修改 GPS 位置：PhotoGallery 批量模式工具栏新增「修改位置 (N)」按钮；展开内联纬度/经度输入框；handleBatchSetGps 校验 ±90/±180 范围后遍历 selected 调用 updatePhotoGps；通过 onGpsUpdate prop 回调同步 App state 中的 photos 数组
2.45 重要片段 Top 20 限制：PhotoGallery 新增常量 MOMENTS_MAX = 20；momentCards useMemo 中将 ranked.slice(0, visibleCount) 改为 ranked.slice(0, MOMENTS_MAX)；hasMore 加入 !momentsMode 条件，重要片段视图不显示「加载更多」按钮
2.46 change file 管道：changes/ 目录下所有文件命名规范为 YYYY-MM-DD-id.json，文件内 id 字段与文件名（去掉 .json）一致；scripts/create-change.mjs 支持 stdin 管道模式（!process.stdin.isTTY 时读 JSON 跳过交互）；deploy-frontend.yml 在 Build 步骤前执行 node scripts/collect-changes.mjs 自动重建 changelog.json；sync-changelog.yml 在 changes/** push 时自动同步到 Cosmos DB changelogs 容器
2.47 登录首屏分包：AuthenticatedApp.tsx 必须通过 React.lazy 动态导入 PhotoGallery，未认证状态不请求图库 chunk；认证工作区挂载后 useEffect 立即调用同一 loader 预载，使图库代码下载与照片列表请求并行。时间线与重要片段均提供「正在加载照片视图…」Suspense fallback；构建产物必须包含单独的 `PhotoGallery-<hash>.js`。Workbox 的应用代码预缓存仅包含 index.html、入口 JS/CSS、React vendor、PWA 注册和 workbox-window，另保留安装所需 manifest/图标；其他 `/assets/` chunk 使用 `app-code-v1` CacheFirst 在首次请求后缓存，PhotoGallery 不得出现在 sw.js precache manifest。
2.48 认证工作区分包：App.tsx 只保留 ToastProvider、AuthProvider、AuthPage、会话门和 Suspense/ErrorBoundary；完整工作区及 GroupProvider 位于 React.lazy 加载的 AuthenticatedApp.tsx。模块加载器缓存同一个 Promise：已有 token 在模块初始化时预载，登录与注册提交通过 AuthPage onAuthIntent 在 API 请求前预载。chunk 失败时必须显示可刷新恢复 UI；构建产物必须存在 `AuthenticatedApp-<hash>.js`，且该文件不得进入 sw.js 预缓存。
2.49 认证前样式分包：main.tsx 入口继续加载 index.css，但该文件只能包含全局 reset、AuthPage、AppSplash 和工作区 chunk 恢复样式，源码保持在 20 kB 内且不得出现 app-header、photo-grid 或 workspace-sidebar。AuthenticatedApp.tsx 单独导入 authenticated.css，构建必须生成 `AuthenticatedApp-<hash>.css`；登录入口 CSS 必须小于 12 kB，认证工作区 CSS 与 JS 均不得进入 sw.js precache，并在首次认证意图后由 `app-code-v1` 缓存。index.css 与完整工作区中的 Auth Page 区段必须保持一致，防止同一会话注销后登录页样式漂移。
2.50 认证服务边界：AuthContext.tsx 必须直接从 authApi.ts 导入 AuthUser/AuthResponse 与登录、注册、会话、资料 API，并从 http.ts 导入 token 生命周期工具，禁止通过 photoApi.ts 兼容 barrel。构建后的 `index-<hash>.js` 必须小于 32 kB，且不得包含媒体线路超时、候选预载或媒体 fallback 错误文本；这些照片工作区 helper 只能随 AuthenticatedApp chunk 加载。
2.51 私有照片缓存生命周期边界：AuthContext.tsx 只能从 privatePhotoCacheLifecycle.ts 获取账号/角色归属准备和清理能力，禁止直接导入 photoListCache.ts。轻量生命周期 shell 必须在清理前同步递增 generation、同步通知内存缓存 reset、同步删除当前 owner 的作用域键，并保留在登录入口；清理调用必须先 `await import("./privateCacheReset.ts")`，由该最小边界完成旧版无归属键、写入 drain、Cache Storage 删除和 SW fence，再通过 `import("./privateCachePurge.ts")` 按需加载并 await Workbox IndexedDB schema/open/cursor/定向删除实现。所有注销、401、无效恢复、切号/角色变化和跨标签替换路径必须 `await` 清理 promise，chunk 加载、数据库打开、cursor、事务、Cache Storage 或 SW fence 失败必须保留原始错误、未完成 marker、空 owner 与关闭的持久缓存；认证启动可在该 fail-closed 状态继续仅在线会话，通过 console 与既有 toast 明确提示并在下次打开时幂等重试，禁止把状态记为成功、采用旧 owner、自动 reload 或形成刷新循环。缺失数据库或对象仓库仍是可识别的幂等结果。清理必须等待已注册的持久化写入并重复两轮，只用 `cacheName` 索引 key cursor 删除照片列表、当前媒体与旧版媒体缓存名对应的 Workbox 行，不得读取 URL、SAS、照片名、值或 URL-bearing 主键，且禁止删除数据库、对象仓库、`app-code-v1`、precache 或无关行。私有媒体 Workbox handler 必须在请求开始捕获 fence generation；清理在删除前发送 `begin` 并等待确认，使旧 generation 的迟到响应无法写入，仅在替换 owner 清理成功后发送匹配 generation 的 `resume`。构建必须保留 36,000 B raw 登录入口硬门禁，并验证 `privateCacheReset-<hash>.js` 由 SW precache 但不在 HTML preload，且 `privateCachePurge-<hash>.js` 独立成 lazy chunk、不在入口实现、HTML preload 或 service worker precache 中。
2.52 照片策略模块边界：http.ts 必须从 authScope.ts 获取 JWT authorization snapshot，从 apiRoutingPolicy.ts 获取安全重放、代理探测 TTL 和昂贵读取分类；禁止导入 photoLoadingPolicy.ts。photoLoadingPolicy.ts 仅保留照片列表 cache key、发布代次、刷新节流和媒体缓存资格规则；apiHedgePolicy.ts 单独持有 primary/fallback 竞速状态机。构建后的 `index-<hash>.js` 必须继续遵守当前 36,000 B raw 硬门禁，且不得包含照片列表 `:group:` cache key 或 hedge 状态机文案；行为测试必须继续覆盖角色隔离、路由竞速、取消和昂贵读取不 hedge。
2.53 注册表单意图边界：AuthPage.tsx 只保留默认登录表单，并通过缓存同一个 Promise 的 React.lazy loader 加载 RegisterForm.tsx；注册 Tab 的 pointer hover、键盘 focus 与实际切换均触发预载。RegisterForm 挂载后在登录/注册 Tab 间保持字段状态，注册提交仍必须在 API 请求前调用 onAuthIntent 预载认证工作区。构建必须产生唯一 `RegisterForm-<hash>.js`，该 chunk 不得进入 sw.js precache；登录入口必须小于 27.6 kB，且不得包含「正在创建账号…」注册提交文案。
2.54 媒体快路径：时间线、重点片段和文件夹只允许前 `GALLERY_EAGER_MEDIA_COUNT = 6` 张派生图使用 eager/high priority，其余保持 lazy；后台直连/代理竞速改变首选线路后，已加载照片状态及卡片 URL 必须重路由。普通图片查看器首次打开只能按 thumbnail → preview → original fallback 选择，不得因高 DPR 自动下载 original，且主图使用 high priority；视频查看器只在用户打开后挂载并使用 `preload="auto"`，网格仍不得创建原视频元素。下载接口必须校验 `personal/{userId}` 或已加入的 `groups/{groupId}` 路径，拒绝 derivative/voice 内部 Blob，接收清洗后的 filename 并直接签发附件 SAS，不读取 Blob properties；客户端票据缓存按 auth generation 隔离、最多 8 条，查看器打开后预热，点击不得等待媒体 HEAD。视频上传开始前必须启动本地封面提取，原 Blob 创建后再持久化封面。
2.55 更新弹窗关键路径延后：AuthenticatedApp.tsx 禁止静态导入 WhatsNewPopup；必须通过 `const loadWhatsNewPopup = () => import("./components/whats-new/WhatsNewPopup")` + `lazy(loadWhatsNewPopup)` 形成独立 chunk。`loading=true` 时不允许挂载弹窗组件（因此不得触发 fetchChangelogs），`loading=false` 后仅允许通过 `requestIdleCallback({ timeout: 2000 })` 调度挂载，并提供 `setTimeout(..., 0)` 兼容 fallback。切回 loading 或组件卸载必须 `cancelIdleCallback`/clearTimeout 并通过 requestId guard 拒绝迟到挂载。构建产物必须存在唯一 `WhatsNewPopup-<hash>.js`，且该 chunk 不得进入 sw.js precache。
2.56 PWA 更新激活路径与传输守卫：`main.tsx` 的 `registerSW().onNeedRefresh` 禁止调用 `updateSW(true)` 或 `location.reload`，只能持久化全局 `__CF_PWA_UPDATE_READY__` 并派发 `cloudphoto-pwa-update-ready`。AuthenticatedApp 初始 `updateReady` 必须读取该 flag，后续通过事件同步，保证事件早于登录/工作区挂载时仍可恢复提示。用户显式点击是唯一激活路径；`uploadProgress !== null || downloading || deleteProgress !== null` 任一成立时，更新按钮 disabled 且文案明确「传输完成后更新」，并阻止激活 waiting worker / 刷新页面。
2.57 语音备注全局传输守卫：时间线、重要片段、文件夹三个长期挂载视图需按 source key（timeline/moments/folder）独立上报 `voiceState`（idle/recording/uploading）；顶层必须聚合并派生统一 `transferring`，其中 recording 与 uploading 都算 active。任一 source 卸载时必须清理为 idle，且一个 source 清理不得覆盖另一个仍 active 的 source。统一守卫用于 beforeunload、切 Tab、切群组和 PWA 更新按钮；transfer banner 必须新增语音分支，区分「录音中，请先结束录音」与「语音备注上传中，请勿关闭页面」，不得误报为下载中。
2.58 最近更新模态键盘契约：WhatsNewPopup 可见时保存当前焦点并在挂载后聚焦关闭按钮；Escape 触发既有关闭动画，Tab/Shift+Tab 必须按当前可见控件重新计算并首尾循环，展开/折叠后仍成立。用户键盘聚焦或交互必须取消 idle/fade 计时器并 pin 弹窗；关闭动画完成或卸载时仅当原元素仍 `isConnected` 才恢复焦点。所有 idle/fade/close/initial-focus timer 在卸载时清理且异步回调必须有 mounted guard。条目摘要必须为 `button type="button"`，详情与修复折叠区使用稳定 `aria-expanded`/`aria-controls`/`id` 关联，弹窗通过 `aria-labelledby` 引用可见标题。不得改变 2.55 的 lazy chunk、照片 loading 后 idle 挂载、迟到任务 guard 与 SW precache 排除契约。
2.59 已登录 Header 安装入口约束：AuthenticatedApp 的 `.app-header` 禁止渲染 PWA 安装按钮或保留 `.header-install-button` 样式，避免挤压群组切换、照片数量和用户菜单。PWA 安装仍需在登录页、用户菜单与「设置 → 应用」中可发现，取消原生安装提示后的文案必须指向这些真实入口。
2.60 批量照片 mutation 全局守卫：新增纯逻辑 `batchMutationState.ts`，source 固定为 timeline/moments/folder，operation 至少携带 id、kind(rename/time/location/move)、done、total、failed。start 可替换同 source 的旧 token；progress/finally 只有 token 匹配才可更新或清理，因此一个 source 完成不得影响其他 source，旧操作迟到事件不得清理新操作。PhotoGallery 覆盖 rename/time/location，FolderView root 必须向 FolderContent 透传并覆盖 move/rename/time/location；第一条请求前上报 start，所有 item settled 后的 finally 上报 finish，卸载 cleanup 不得提前报 idle，卸载后不得 setState。同步 ref gate 阻止双击重入；BatchOperationsBar 通过真实 disabled/aria-busy 禁用选择、全选、rename/time/location/delete/LocationSearchPanel，FolderView 同时禁用移动选择/确认和添加原图。移动最大并发为 4，reject 与 resolved false 均计失败且不提前中止；重命名、时间、位置保持串行。顶层把任一 active batch mutation 纳入既有 transferring，复用 Tab、群组、beforeunload 与 PWA 更新闸门；横幅与 guard 文案必须显示具体操作、done/total、failed 和百分比。
2.60a 历史视频封面修复队列：PhotoCard 对内容有效的 thumbnail/preview 保持 0 个原视频修复请求；缺失派生图、派生图所有有限线路均失败，或 HTTP 200/naturalWidth=400 但像素近乎均匀纯白/浅灰时，只有进入 `IntersectionObserver(rootMargin: 600px 0px)` 的卡片才在 idle 调度后订阅全局按 blobName 去重的队列。低信息判定必须同时约束中性像素占比、亮度标准差、动态范围和接近空白的明暗区间，不得把正常明亮但有纹理/色彩的照片误判。同一 Blob 的所有实例共享 queued/repairing/succeeded 状态和新 URL。`saveData=true`、离线、slow-2g/2g 时自动并发为 0；未知网络并发 1，明确 3G/4G 最多 2；单视频估算上限 48 MiB、会话估算预算 160 MiB，不伪造实际下载字节。每 Blob 最多尝试 2 次，失败后至少退避 30 秒且仅重新进入视口才重试。执行器创建不进入布局的 muted/playsInline `HTMLVideoElement`，metadata 后在稍后时间点采样最多 3 个候选帧并选择信息量最高的一帧，复用共享 canvas WebP 提取和 `setVideoThumbnail` ETag 端点；主线路明确失败后最多切一次现有备用线路。离开视口、卸载、离线或 auth generation 变化必须 Abort 并 pause/remove src/load，清理 timer/listener。缺失、低信息、超预算、慢网和失败状态显示「打开视频后生成封面」，排队/生成显示 aria-live「正在生成封面」；MediaThumb、历史上的今天、故事和地图不得把无封面视频显示为白块或被动加载原视频。新上传本地截帧持久化期间必须占用同 blobName reservation，成功 URL 直接发布给队列而不重启原视频修复，并发 endpoint 写入复用同一 Promise。
2.60b 视频播放中途停滞恢复：PhotoGallery 与 FolderView 必须复用 `useResilientVideoPlayback`，不得各自维护 timer/fallback。浏览器只对同源 `/media` 代理执行 `Range: bytes=0-1` 探测且只接受 `206`，响应体无论合格与否都立即 cancel，SAS query 原样保留；代理忽略 Range 返回 `200`、失败或超时则优先 direct，不得用会被存储 CORS 阻断的 browser fetch 探测跨域 Blob。跨域 direct Blob 播放不得强制 `crossorigin="anonymous"`，以兼容未开放 CORS 但可正常 Range 播放的存储；direct loadeddata 不得尝试 tainted canvas playback thumbnail capture，同源 proxy 才可按 session claim 一次。`waiting`/`stalled` 仅在 document 可见、用户仍有播放意图、元素未 pause/seek/end 且 currentTime 连续 4 秒无进展时触发一次 direct↔proxy；`readyState=4` 不是进度证据，不能单独阻止 watchdog。playing/timeupdate/canplay/pause/seeking/ended/hidden、photo navigation 与 unmount 必须清理 watchdog。中途换线保存 currentTime、play/pause intent、muted、volume、playbackRate，loadedmetadata 后先 seek 再安全 resume，play reject 不形成未处理异常；旧 source、旧 session、旧 photo 和旧 timer 事件不得修改新 viewer。每个 session 每条线路最多一次；双线路 error/持续 stall 后结束 spinner并显示「视频加载失败/重试」，重试创建新 key/线路预算并从最后位置恢复。poster 更新不得重建或双播播放器。
2.60c 主动播放修复已知坏封面：PhotoCard 与 MediaThumb 在派生图 URL 可加载但像素低信息、或所有有限派生线路失败时，必须按 auth generation + 完整 workspace blobName 写入共享内存 registry；切换账号清空，个人与群组同名短文件不得互相继承。viewer 的 `needsThumbnailCapture` 必须为 missing derivative OR known-broken，不受 48 MiB 被动队列上限影响，但不得因此创建第二个 video、seek、预下载或增加原视频请求。只能复用当前 viewer 在 `playing/timeupdate` 后已解码且 currentTime≥0.1s 的帧；先做与被动队列相同的低信息评分，纯白/纯灰、无可读像素或 CORS-tainted 帧不得 claim 或上传，第 0 帧 loadeddata 不得捕获。direct no-CORS 线路无法读 canvas 时必须跳过并保留 session 机会，只有后续可读 proxy 帧才可尝试；每个 View session 最多 claim 一次，endpoint 写入按 auth generation + blobName 复用同一 Promise。photo/token/session stale 时不得更新新 viewer；成功后清 registry，并通过既有 onThumbnailUpdate 立即同步 timeline、moments 与 folder。
2.61 Settings 历史维护任务守卫：`maintenanceTaskState.ts` 必须以 operationId、kind(thumbnails/metadata)、workspaceId、processed、changed、skipped、failed、hasMore、phase 建立纯状态边界，所有 progress/complete/stop/clear 仅在 token 匹配时生效。`backfillPhotoMetadata` 与 `backfillThumbnails` 保持旧调用兼容并接受可选 AbortSignal/onProgress，每个已验证页面立即上报累计值，abort 不得发下一页，缺失/重复 cursor、auth generation 漂移和 HTTP 错误继续显式失败。SettingsDialog 通过同步 ref gate + 单一 AbortController 禁止双击与跨类型重入，两按钮共享 disabled，aria-live/aria-busy 展示累计进度并提供停止按钮；停止、卸载或 workspace 漂移会 abort，保留完成页统计且 mounted/token guard 禁止迟到更新。运行中遮罩和关闭按钮不得卸载设置。AuthenticatedApp 通过 onMaintenanceStateChange 聚合 active 状态并纳入 Tab、GroupSwitcher、beforeunload、PWA 更新与 transfer banner 守卫；总数未知时只显示计数，不显示百分比。已登录 Header 继续禁止 `header-install-button` 与顶部安装文案。
2.62 回收站 mutation 守卫：新增纯逻辑 `trashMutationState.ts`，kind 固定覆盖 item-restore/item-delete/restore-all/empty-trash/restore-folder/delete-folder，状态携带 operationId/token、workspaceId、label、done、total、failed 与 running/stopping/stopped/completed phase；所有 progress/final 事件必须 token 匹配，旧任务迟到事件不得覆盖新任务。TrashView 的六类入口共用一个同步 ref gate 与可测试串行 runner，按点击时稳定快照逐项执行，普通失败计入 failed 后继续，Abort 不计失败且不得启动下一项；`restorePhoto`/`permanentlyDeletePhoto` 保持旧调用兼容并将可选 AbortSignal 传入 `fetchWithTimeout`。停止、真正卸载或 workspace 漂移必须 abort 当前请求并重新读取远端回收站，保留部分 done/failed 且不伪造已完成永久删除的回滚。顶部、文件夹、卡片和移动端固定恢复/删除按钮在 active 时均使用原生 disabled，进度状态通过独立 aria-live 区域展示。TrashView 通过 SettingsDialog 向 AuthenticatedApp 上报事件；Settings 关闭与维护任务互斥，顶层把 active trash mutation 纳入既有 Tab、GroupSwitcher、beforeunload 与 PWA 更新守卫，并优先展示准确 label、done/total、failed 和 percent。已登录 Header 的安装入口删除约束保持不变。
2.63 Settings 模态键盘与全局快捷键隔离：`.settings-dialog` 必须使用 `role="dialog" aria-modal="true"` 并由 `aria-labelledby` 引用可见标题。挂载时只保存一次原焦点并聚焦关闭按钮，卸载时仅向仍 `isConnected` 的原元素恢复；Tab/Shift+Tab 每次按键动态枚举当前可见、enabled 控件并首尾循环。Escape 必须调用既有 protected close，因此 active maintenance/trash 继续 toast 且不关闭；设置内所有普通键 stopPropagation，但不 preventDefault 输入或复制粘贴。模态焦点 helper 与 WhatsNewPopup 共用 `components/shared` 实现，且不得破坏 WhatsNew 独立 lazy chunk、idle mount、请求代次与 SW precache 排除。AuthenticatedApp 的纯 eligibility helper 必须拒绝 defaultPrevented、IME composing、重复 R/数字 Tab mutation、input/textarea/select/button/link/contenteditable/role=button 等交互目标及页面上的 `[aria-modal="true"]`，无模态 body 事件继续保留 R/?/1–6/S/Backspace/Delete/Escape 行为。不得修改 PhotoGallery/FolderView 查看器快捷键，也不得恢复已登录 Header 的安装入口、CSS 或顶部安装文案。
2.64 全局文件意图守卫：新增纯策略复用 `globalShortcutEligibility` 的交互目标 selector 与 `[aria-modal="true"]` 判定，并明确返回 accept、ignore-editor-or-modal、block-transfer（无文件另行忽略）。全局 paste 仅在 clipboard 提供有效图片、焦点不在 input/textarea/select/button/link/contenteditable/role=button、无模态层且最新完整 transferring 为 false 时 preventDefault 并调用一次根目录上传；编辑器/模态场景不 preventDefault、不 toast、不上传，activity 场景 preventDefault 并显示当时最新 guard，且不得提前显示成功 toast。全局 desktop drag 在 modal 或 upload/download/delete/voice/batch/trash/maintenance active 时不显示 overlay、不切 Tab，drop/dragover 仍 preventDefault；drop 只提示一次并清理 enter counter/overlay。正常无阻塞拖入继续只切 folder Tab 并提示选择文件夹，touch-primary 不注册，显式 UploadArea/file input 不增加额外限制。已登录 Header 继续禁止安装入口、CSS 与顶部安装文案。
2.65 已认证首屏媒体边界：selection-ready 必须绑定当前授权用户；持久化群组选择完成成员验证前，照片工作区不得读取个人列表缓存、渲染个人卡片或请求无 `groupId` 的 `/photos`，恢复后只允许请求该群组；明确 personal 可独立 resolve，群组 API 失败时仍可恢复。照片 effect 依赖稳定 resolved workspace ID，`groupsLoaded` 后续变化不得重启 personal 请求。同工作区成功刷新后 5 分钟内 focus/visibility/视图返回不得重复拉取和 JSON decode 全量列表，进行中的请求不得被 focus 重启。时间线、历史片段、故事、地图详情与文件夹网格仅使用授权 `thumbnailUrl`/`previewUrl`，旧缓存对象缺少 derivative 时显示本地占位，不得 fallback 到 `url`。打开 viewer 后可按 thumbnail→preview 策略显示，原图仅由显式原图预览、动图播放或下载触发；视频无封面继续显示本地占位且不得挂载原视频。行为 fixture 必须量化恢复刷新 personal request count=0、首次稳定渲染 personal card count=0、初始 grid original-media request count=0、同工作区 in-flight restart count=0；源码和构建产物同时保留策略契约。服务端 cursor pagination 仅能在照片缓存、MemoryMap 与统计消费方完整迁移后另行实施，不得半分页。已登录 Header 继续禁止 `header-install-button`、对应 CSS 与顶部安装文案。
2.66 文件夹重命名安全与离开保护：服务端 oldFolder/newFolder 必须是无空段、`.`、`..`、反斜杠和控制字符的规范相对路径，只允许同一 parent 下替换最后一段；NFC 后相同返回 `renamed=0`，但非等价改名必须保留 oldFolder 的原始 Unicode storage key。权限继续使用 personal owner/group membership；任何 mutation 前必须完整检查 oldPrefix 与 targetPrefix，源分页最多读取 101 条以判断 100 条上限，目标分页最多读取 1 条，源空返回 404，目标任意 Blob 返回 409「目标文件夹已存在」。所有原图、thumbnail/preview/voice/视频派生 Blob 按相对路径复制，整批只获取并复用一个受 request AbortSignal 约束的 delegation key；`beginCopyFromURL` 必须同时使用 destination `conditions.ifNoneMatch="*"` 与 preflight source ETag `sourceConditions.ifMatch`，且不覆盖 metadata/content headers；全部复制成功并复核 source/target inventory 前不得删除源。copy/delete/rollback 并发常量集中为 4/4/2；调度器必须记录 active peak，copy 首个失败后不再派发新 item，但等待已启动 item settle 后再以 2 路上限 best-effort rollback，禁止无上限 `Promise.all`。单次超过 100 个 Blob 必须在 mutation 前返回 413；copy phase 120 秒截止或 poll 失败时必须按 copyId 直接调用 Blob abort，不能依赖已进入 completed/error 状态后会 no-op 的 poller cancel；rollback 60 秒截止且每个 storage call 传 AbortSignal，服务端总请求 210 秒边界低于客户端 220 秒上限。429/503/ServerBusy 完全依赖 Azure SDK 的 Retry-After/指数退避，应用层不得自建 retry loop。复制失败只能在 copyId 与最新 ETag 均证明目标仍归属本 operation 时条件删除，copy initiation 响应不确定、所有权不明或 rollback 失败须记录并返回 recovery-needed。删除每个源前必须获取 60 秒目标租约并验证对应目标的 final copyId + ETag，整个 source delete 关键区必须受最长 20 秒 AbortSignal 约束，为租约保留 40 秒安全余量，再以 preflight source ETag 条件 `deleteIfExists`；目标/源已变化或删除失败时不得删对应目标，返回非 2xx、remainingSources，并保证每项至少一份；完成后再次核对 inventory，不得把并发变化伪报成功。客户端 rename API 保持旧调用兼容，增加可选 AbortSignal 与 220 秒 HTTP 上限；FolderView 在请求前拒绝 `/`、`.`/`..`、反斜杠/控制字符和同级冲突，同时保留 oldFolder 原始 key。顶层 folder rename state 携带 operationId/workspaceId/old/new label/phase，同步 ref gate 防双击，stale finally 不清新任务；active 时根层/递归 FolderCard、文件夹创建/删除、批量、上传和移动入口真实 disabled，并纳入 Tab、GroupSwitcher、beforeunload、全局文件意图和 PWA update `transferring`。根目录和递归 FolderCard 外层必须是具有稳定名称、无 click/key handler/tabIndex 的非交互 `group`；进入动作只由独立 `button type="button"` 承载，完整 aria-label 格式为「打开文件夹 <名称>，<数量> 张照片」，空白名称回退到「(未分类)」，超长/emoji 名称不得在可访问名称中截断。打开按钮依靠原生 Enter/Space 语义且不得额外绑定 key handler，busy 时真实 disabled；重命名输入、重命名/删除按钮不得嵌套在进入按钮内，必须按打开、重命名、删除的 DOM 顺序保持独立 Tab stop、事件隔离和可见 focus。两个 action 在桌面及 680/360px mobile media 下均继承至少 44×44 的命中区域、互不重叠的位置与显式 focus ring，并以独立 z-index 覆盖主按钮但不阻断冒泡到 card 的 drag enter/leave/drop；action、拖放与 disabled gate 均不得误打开。workspace 漂移必须 AbortSignal 停止客户端等待；成功、失败、timeout 或 partial server error 均通过当前 workspace 的最新 `fetchPhotos` callback 对账，不得把旧空间 closure 的结果应用新空间；单次请求协议没有可信 server progress 时，banner 只显示「正在重命名文件夹 A → B」及本地 phase，不得伪造百分比或计数。不得恢复已登录 Header 安装入口/CSS/顶部文案或移动 Header。
2.67 PhotoCard 键盘、触控与对比度契约：timeline 日期组、历史回忆、重要片段、moments 与 FolderView 必须复用同一 PhotoCard。外层使用无 click/key handler/tabIndex 的具名语义 `group`，主打开/选择动作只能由独立 `button type="button"` 承载；其 descendants 必须全部符合原生 button 的 phrasing-content model，且不得包裹收藏、删除、移动、GIF 控制或其他 action。主按钮在普通模式依赖原生 Enter/Space 调用 viewer，在 batch 模式调用 onSelect 并以 `aria-pressed` 表达 selected；busy 时真实 disabled。aria-label 只含原文件名、媒体类型和可用日期，不得拼入 URL/SAS。文件名、日期、照片计数和新建文件夹入口的对比度至少 4.5:1；移动、收藏、删除、重命名、hover/selected、选择边界和 focus-visible 对相邻背景至少 3:1，操作字形使用 currentColor。收藏与删除保持独立兄弟操作和至少 44×44 hit box，主按钮 focus ring 在 overflow-hidden 卡片内可见；batch selection 或 busy 时必须隐藏并阻止 GIF 控制变更，已播放 GIF 同步回到 derivative-only 静态封面，不能继续挂载原 GIF。操作菜单、视频封面 repair、touch 与拖放不得回归。source contract 必须证明 PhotoGallery 的 timeline/moments/insight 与 FolderView surface 均使用共享组件。
2.67 移动端布局与 PWA meta 契约：320px/390px 下 `.weekly-summary-card` 必须通过与 `.view-tabs-shell-wrap` 同源的 inline padding 变量保持 viewport full-bleed，根文档 `scrollWidth === clientWidth` 且不得用 html/body 全局 `overflow-x:hidden|clip` 掩盖；`.view-tabs` 继续 `overflow-x:auto` 独立横向滑动，本周标题不得被压缩裁切。≤360px 的 `WorkspaceFab` 默认只显示至少 48px、含 safe-area 的单入口，展开后保留筛选/片段侧栏及两个快捷动作；按钮暴露稳定 `aria-expanded`/`aria-controls`，展开聚焦首动作，Escape 收起并把焦点还给入口，桌面布局不变。源码与 dist 都必须同时包含 `mobile-web-app-capable=yes` 和 Apple meta；production smoke 校验线上 HTML。不得恢复 `.header-install-button`、对应 CSS 或顶部安装文案，也不得移动 Header 掩盖布局。
2.68 上传吞吐、真实进度与背压：新增纯函数网络策略和加权队列，图片权重 1，视频或超过 20 MiB 的大文件权重 2；4G 预算 3（最多 3 图或 1 视频 + 1 图），未知/3G 预算 2（不能退回全部小图串行），`saveData`/slow-2g/2g 预算 1，超预算重项允许独占防饥饿。状态覆盖 pending/preparing/uploading/succeeded/failed/cancelled，aggregate 必须分别暴露 succeededCount/failedCount/cancelledCount：succeeded 按完整 file.size 结算，preparing/uploading/failed/cancelled 只保留 clamp 到 `[0, file.size]` 的真实 loaded；正文前 413 可为 0，部分网络失败保留部分字节，服务端完整收 body 后失败可自然等于 size。每次请求 attemptLoaded 可重置，跨重试/线路回退的 transferredBytes 必须按实际正向 delta 单调累计并供 EMA 使用，不得把未传字节或重置误计为速度。暂停只阻止新 dispatch，不 abort 已开始 XHR。批次捕获 auth generation、workspace、显示名和 groupId，空间/认证漂移共用 AbortSignal；每文件 uploadId 在 retry loop 外生成。队列 settle 后等待照片刷新期间必须保持 `uploadProgress !== null` 离开/PWA guard，失败 batch 显示成功/失败/取消与真实百分比，不得写回 `bytesLoaded=bytesTotal` 或显示伪成功；旧 pause flag 不得覆盖无 active/queued 的 settled 结果。最终 toast 始终同时报告成功/失败数，并在存在时报告取消数，按唯一 queue item 最终状态统计，retry/partial failure 不重复计。XHR 错误携带 kind/status/retryAfterMs；仅 network/timeout/408/425/429/5xx 最多三次，Retry-After 支持秒和 HTTP date，并使用 1 秒基数、30 秒 jitter cap、60 秒总 cap 的 exponential full jitter，AbortSignal 可中断离线与 delay 等待；401/403/404/409/413/422 不重试。视频本地封面提取/持久化必须留在 weight-2 worker 生命周期内，不能与下一视频重新放大内存。服务端 MIME 通过后、`arrayBuffer()` 前解析 Content-Length，声明超限立即 413，缺失 411、非法 400；读取后继续验证真实长度不超限且与声明一致。单 Function 实例准入总权重 3/256 MiB、单用户权重 3/220 MiB，lease 覆盖 Blob 写入和图片派生生成并 finally 幂等释放，活跃用户归零删除、表上限 1024；拒绝 429 + 可跨域读取的 Retry-After: 3。必须明确这是单实例保护，不伪装分布式限流；无全站实测证据时不得给 host.json 添加会影响轻请求的 HTTP concurrency。下载保持附件 SAS → 浏览器直连 Blob；不得恢复 `.header-install-button`、CSS 或顶部安装文案。
2.69 时间线侧栏筛选、认证日期与移动触控契约：`FilterBar` 必须提供显式 `default | sidebar` variant，只有 `WorkspaceSidebar` 使用 sidebar scope；默认宽桌面 `.filter-main-row` 继续保持原单行 flex 行为。sidebar variant 以自身 inline-size 为响应边界，搜索与 hasAny 清空按钮组成首行，≤260px 有效容器时可拆为两行；收藏、无主题、未分类、无 GPS、结果数与网格尺寸保持后续 DOM/tab 顺序并允许多行重排。抽屉/内容在 320、456、480px 及 456px@200% 的 228px 有效宽度下必须 `scrollWidth === clientWidth`，根文档不得横向滚动；真实 320px 视口使用自然 262px 抽屉时，内容中的 224px `.filter-main-row` 也必须保持 `scrollWidth === clientWidth`，每个可见控件的左右边界均落在内容区内。侧栏关闭时必须 inert；打开时使用 modal dialog 语义、聚焦关闭按钮并将 Tab/Escape 保持在侧栏内，关闭后才把焦点恢复到仍可见入口。长中英文标签、搜索内容、激活 chip、清空入口和筛选字段不得裁切，所有按钮/输入/选择控件至少 44px。sidebar FilterBar、`PhotoTimeEditDialog` 与 `TimeCapsule` 必须复用同一 native-control scope：font family 继承认证界面字体栈，基础字号 0.85rem、line-height 1.25、weight 400，日期/时间数字使用 tabular-nums。`input[type=date]` 必须保留原生类型、picker、calendar indicator 与 `YYYY-MM-DD` 状态/API 值，契约不得依赖浏览器按 locale 呈现的输入框文本；TimeCapsule 的默认解锁日、最小可选日、当天解锁判断、剩余日数和创建日期必须通过共享本地日历 key/日差生成，创建入口同时禁用并拒绝早于最小日期的值，禁止 UTC `toISOString().slice(0, 10)` 在跨日边界提前或延后一天。所有认证界面的日期展示必须复用一个显式 `zh-CN` helper；即使默认 locale 强制为 en-US，时间线分组、照片卡片、时间线查看器与文件夹查看器仍输出稳定中文格式，两个查看器使用同一 date-time preset，分组继续以本地中午构造日期避免时区偏移；纯 `YYYY-MM-DD` 按本地日历中午解释，在 America/Los_Angeles 等西时区也不得减一天。invalid date 返回“未知日期”，时间线无效时间戳沿用 epoch 分组回退，不抛错也不渲染 `Invalid Date`。390×844 的真实 CSS/Edge CDP 触控契约必须证明照片卡片 `.favorite-btn`/`.delete-btn` 与 header `.user-avatar-btn` 均为至少 44×44px，收藏/删除命中区互不重叠，中心 `elementFromPoint` 准确命中，`:focus-visible` 有至少 2px 的非 none outline，且 document `scrollWidth === clientWidth`；320/360px 文件夹网格必须退为单列，使移动、收藏、删除动作完整位于 card bounds 内且相互不重叠，390/430/480px 双列也必须满足同一边界；移动 header 实际 60px 高度与 sticky tabs top 必须读取同一 CSS variable。现有 WorkspaceFab compact breakpoint 必须为 `max-width:480px`，在 320/360/390/430/480px 均默认只显示 safe-area-aware 48px launcher，CSS 必须以 `!important` 覆盖桌面拖动保存的 inline left/top；展开 actions 在每个边界都完整位于 viewport 内且不制造 document overflow。Escape 收起并把焦点还给 launcher；点击外部只收起不恢复焦点；执行 sidebar/recent/organize 等任一 action 时先把焦点同步交给仍可见 launcher，随后收起并执行目标动作，使新界面捕获可见返回点且不被延迟抢焦点；`aria-expanded`/`aria-controls` 始终准确。不得把 44px 规则扩大到 group switcher、tabs、quick chips、folder actions 或 map markers；这些至少 24px 的紧凑控件保持现有密度。禁止通过新增 `overflow:hidden|clip` 掩盖溢出，并继续禁止 `.header-install-button`、对应 CSS、顶部安装文案或 Header 位移。
2.70 照片/视频查看器、时光胶囊与自动故事模态边界：PhotoGallery、FolderView、TimeCapsule 创建器/查看器及 AutoStory StoryPlayer 必须使用 `role="dialog" aria-modal="true"`、可见标题或内容可访问名称与 `tabIndex=-1`，并通过 body portal 使 `#root` 可安全 inert；实现不得硬编码 `.modal-content`。共享 stacked modal boundary 只允许栈顶层可访问：活动层外所有 body child 必须保存后设置 `inert` + `aria-hidden=true`，同构模态 sibling 还必须隐藏；出栈时精确恢复既有值，并通过 body child observer 隔离活动期间迟到挂载的 portal。事件边界必须使用 same-target immediate propagation guard；WhatsNew 等旧 document handler 在共享栈活动时也必须主动退出并取消自身显示。父 viewer 在原图预览或拍摄时间编辑子层打开期间不得处理焦点或按键，子层关闭后仅向仍 connected 的父控件恢复。打开 viewer/StoryPlayer 后初始焦点落到关闭按钮；打开胶囊创建器后聚焦名称输入框，Escape、遮罩、取消或关闭后恢复实际触发器。Tab/Shift+Tab 每次动态枚举当前可见 enabled 控件，覆盖重命名、分享、移动、位置编辑及当前增量窗口中已挂载的胶囊照片按钮；焦点被程序化移到层外时必须拉回活动层。所有模态按键必须在 document 边界停止传播到 window/global shortcuts，但输入编辑器保留自身 Enter/Escape；viewer 继续支持 Escape、左右箭头、F、D、Delete、?，帮助层内 `?` 仍可关闭帮助，且聚焦的 audio/video controls 必须保留原生按键与 Tab 顺序。StoryPlayer 保留 Escape、左右键、播放/暂停和计数，图片使用 `selectGridMediaSources` 的 derivative 次序，视频与预览网格必须复用 MediaThumb/videoCoverRepair 的无被动原视频下载和低信息封面修复策略，禁止挂载 `<video>`。桌面/移动端全屏、滑动和媒体播放保持不变。原图预览、快捷键帮助与拍摄时间编辑必须各自有真实 dialog 语义、可访问名称及独立 boundary。已登录 Header 继续禁止 `header-install-button`、对应 CSS 与顶部安装文案。
2.71 照片地点地址恢复：`gpsLat/gpsLon` 必须从客户端 EXIF 查询参数或服务端 TIFF/HEIC EXIF + XMP fallback 写入 Blob metadata，`0` 为合法坐标；上传响应和 `GET /api/photos` 刷新后继续返回同一 GPS。生成式 JPEG/HEIC fixture 必须证明当前 `exifr` 同时支持浏览器 `File` 和服务端 `Buffer` 路径，不得仅按扩展名猜测 iPhone HEIC 支持；独立 XMP-only JPEG fixture 必须证明优化的 `exifr.gps` 会遗漏标准 XMP GPS，而上传 fallback 能恢复且拒绝 partial/malformed/out-of-range pair；Extended XMP fixture 必须证明 multi-segment 扫描和 numeric + hemisphere ref 能恢复南/西坐标。新增鉴权 `GET /api/geocode/reverse?lat=&lon=`，严格 finite/range 校验并只返回 `{ address }`；search/reverse 共用带合规 User-Agent、8 秒 timeout、约 1 req/s spacing、有限队列、并发去重和 bounded TTL/LRU 的 Nominatim gateway，429 返回 `Retry-After`，失败不长缓存。客户端 reverse 先走代理，仅对缺失路由、429、502/503/504 或网络失败直连一次；内存缓存按 auth generation + workspace 隔离，成功有界长 TTL、失败短 TTL，支持 AbortSignal。PhotoGallery/FolderView 必须按 photo name + GPS snapshot 取消旧请求，迟到结果不得更新新照片；hook/UI 状态区分 missing-coordinates、loading、resolved 和 unavailable，地址暂不可用不得伪装成无 GPS，也不得在诊断文案中回显坐标。上传成功后必须同步发布 Cosmos location 或显式刷新地图位置索引，不得只等待 groupId 变化。上传时 Cosmos 位置索引失败不得让用户重传原文件，响应以 `locationIndexPending`/warning 显式提示；分页 metadata maintenance 对已有合法 GPS 不下载原图即可执行 ETag 安全的幂等索引 reconcile，并分别统计 metadata updated 与 indexReconciled。`fetchPhotoLocations` 不得吞错伪造空数组，workspace/auth 漂移响应不得覆盖新空间；地图必须丢弃 Cosmos 孤儿、旧交集与非法坐标，并用共享 finite-pair 分类保证有/无位置闭合。已登录 Header 继续禁止安装入口、CSS 与顶部安装文案。
2.72 跨部署 lazy chunk 恢复契约：`main.tsx` 必须在 React root 创建前安装 `vite:preloadError` 监听器；只有错误文本明确属于 dynamic import/CSS preload，且 URL 为当前 origin 的 `/assets/<name>-<至少8位hash>.js|css` 时才 `preventDefault` 并进入恢复，普通 render、业务网络错误、跨域资源、无 hash asset 和 `/api/*` 500 均不得自动刷新。Safari 仅有精确 `Importing a module script failed` 且事件确实来自 Vite `vite:preloadError` 时可用事件 provenance 进入同一恢复，ErrorBoundary 或普通 Error 不得凭该无 URL 文案自动刷新。自动路径以当前 build + 不可逆 chunk 指纹在 sessionStorage 记录一次，值只能包含有界 opaque hash，禁止保存错误文本、模块名、URL、workspaceId、照片、SAS 或 token；同一 chunk/build 及恢复后的迟到事件最多自动 reload 1 次，第二次显示「刷新新版」「稍后重试」友好卡片并保留 raw error 仅在 console；sessionStorage 不可写时必须 fail closed 为手动恢复，自动 reload=0。恢复必须读取 PWA 更新与 beforeunload 共用的全局 dangerous-operation fact，覆盖 upload/download/delete/voice/batch/trash/maintenance/folderRename；active 时 reload=0，显示「新版资源已发布，当前操作完成后刷新」，任务完成后再继续，并在 SW 等待结束后、真正 navigation 前再次检查，防止等待窗口中新启动的任务被中断。VitePWA 必须使用 prompt registration，generated SW 只能在收到 `SKIP_WAITING` 消息后调用 `skipWaiting` 且不得 `clientsClaim`；注册 helper 的 `onNeedReload` 和 `onNeedRefresh` 都只能标记 update-ready，禁止自行 reload。离线时等待 online；安全时有界执行 `registration.update()`，等待 installing worker，向 waiting worker 发送 `SKIP_WAITING` 并等待 `controllerchange`（缺失/超时/失败仍记录 console），再给当前 URL 加内部 cache-busting query 执行一次 `location.replace`，新文档启动后移除该 query。session intent 只允许 timeline/folder/moments/map/capsule/story 枚举；workspace 继续由既有账号绑定持久化恢复。未登录 AuthPage、AuthenticatedApp 顶层、timeline/folder/moments/map/capsule/story 以及所有辅助 lazy 弹窗必须使用独立 ErrorBoundary；常驻面板的可见性 wrapper 必须位于 boundary 外层，FolderView 或辅助 chunk 失败不能遮掉已加载 timeline、卸载 authenticated shell 或终止 active 操作，切回正常页面立即可用；rejected lazy Promise 不得通过单纯清 error state 假装重试，恢复动作必须明确刷新新版。所有 production fallback 禁止显示 `error.message`/stack/module URL，按钮使用 `type=button`、aria-live 并聚焦主要恢复动作。入口恢复器必须保留 built login JS **36 kB 硬上限**，不得通过放宽预算规避 `vite:preloadError`、one-shot marker 或私有 Workbox metadata 清理构建检查；CI 目标约 35.9 kB（gzip 13.1 kB）。已登录 Header 安装入口、CSS 与顶部安装文案约束保持不变。
2.72a 跨部署 hashed asset 保留契约：旧 active Service Worker 或 Cache Storage 控制的 app shell 可能在新 bootstrap 执行前请求旧 `AuthenticatedApp`/panel JS 与 CSS，因此当前受困客户端的主恢复面必须位于部署产物，不能依赖 2.72 的新运行时代码。前端发布必须先读取线上 `deployment-assets.json`，逐项下载并验证历史 hashed `.js`/`.css` 的 SHA-256 与字节数，再与当前代合并；每次 workflow run/attempt 必须使用独立代次 ID，同一 commit 重跑不得覆盖或删除前一构建因 build time 产生的精确 hash。manifest 只能包含 `assets/<content-hash>.js|css`、代次 ID、字节数和摘要，禁止 URL、token、workspace、照片信息及 source map。窗口硬上限为最近 24 个完整代次和 64 MiB 唯一字节，任一上限触发时按 manifest 顺序从最旧完整代次确定性淘汰，不得半代保留或无限累积；`revokedGenerationIds` 必须立即排除历史脆弱代次，并拒绝发布本身已被撤销的当前代。首次线上 manifest 404 时只允许从 policy 中固定的历史 commit 重建 policy 明列的迁移资源；当前事故只将自然生成且与生产请求一致的 `AuthenticatedApp-BkGhvsE_.css` 纳入 bootstrap，禁止把受 build timestamp 影响的重建 JS 冒充原始字节，也禁止建立旧 hash alias。首轮发布后的 JS/CSS 一律从线上保留原始字节。old shell → new deploy 的真实 Chromium/Edge 隔离 profile 契约必须同时覆盖旧 navigation app-shell、waiting worker 未被自动接管、两个 Tab、standalone、旧 lazy JS/CSS 成功加载，以及缺失 `.js`/`.css` 均保持 404 `application/json` 且正文非 HTML；Nginx `/` 只透传 SWA 的状态/MIME，不得用本地 SPA fallback 伪装 asset 404。静态契约还必须验证 manifest 与 dist 完全一致、预算/摘要/撤销/无 source map、入口一次性恢复标记及已登录 Header 顶部安装入口永久缺失。
2.73 时光胶囊照片选择流量窗口：创建弹窗的照片 scroll root 初始最多挂载 18 个 `MediaThumb`，不得以 native `loading=lazy` 代替渲染边界；用户滚动该内部 scrollbox 后，绑定其为 `root` 的 `IntersectionObserver` sentinel 才能以每批 12 个单调扩展，键盘遍历到当前已挂载批次的末项时也必须只扩展一批并保持该焦点项连接，完整来源至少支持连续访问前 60 张且同一窗口内不得重复挂载既有 key。切换 folder/source 与重新打开弹窗必须同步回到首批并把 scrollTop 归零，不能在 effect 后置重置前短暂挂载旧数量；`selectedNames` 和真实创建数量不随窗口重置丢失。已渲染照片不得因扩窗卸载；来源异步变化若当前焦点仍指向保留照片，窗口至少覆盖该索引。关闭或 source 变化必须 disconnect observer，并以 active generation 拒绝迟到 callback。照片和视频封面继续只向 `MediaThumb` 传递 thumbnail/preview derivative，禁止挂载 `<video>` 或被动请求 original/video；创建器原有 `role=dialog`、可访问名称、初始焦点、动态 Tab trap、Escape/取消恢复和背景快捷键隔离保持不变。320px、cache disabled、来源前 60 张的生产门槛为初开 `/media` 请求不超过 18，滚至底可访问完整 60 且无重复请求。
2.74 生产 HSTS 与入口真实性契约：SWA `globalHeaders` 和 `infra/nginx.conf` 所有本地 HSTS 必须严格为 `max-age=31536000; includeSubDomains; preload`；Nginx 前端代理必须隐藏上游 `Strict-Transport-Security`、`X-Content-Type-Options`、`X-Frame-Options` 后保留本地安全头，不得改写 SWA Cache-Control，也不得弱化 `/api`、`/media` 的 CORS/Range/缓存。production smoke 只检查实际部署的 `cloudphotos.top` 与 SWA 默认域名：SWA 必须只返回唯一 canonical HSTS，代理入口的第一个 effective HSTS 必须 canonical；短 max-age、缺 directive 或非 canonical 首值必须失败。VM 模板未热加载时只允许尾部出现已知旧本地值 `max-age=31536000; includeSubDomains` 或重复 canonical，`max-age=0` 等任意其他尾值必须失败；该情况作为 non-blocking infrastructure drift，且不得声称重复已消除。权威 DNS 事实必须分成当前部署与规划：`dns23.hichina.com` 上 apex/www 为 `A 20.195.27.151`，cn/global 为 NXDOMAIN；在 DNS 提供商真正配置前，不得把 cn/global/智能 DNS 写成已上线入口。GitHub 前端部署只更新 SWA，不得尝试未知 SSH、提交 secret 或伪装自动 VM 部署。
2.75 前端 production workflow 并发与凭据契约：`.github/workflows/deploy-frontend.yml` 必须使用 workflow-level concurrency；所有 `main` push 与 `main` 上 `workflow_dispatch mode=production` 共用唯一 production group，`cancel-in-progress` 对这两类 production run 必须为 false。GitHub concurrency 只保证 1 running + 1 latest pending，第三个同目标事件可在 Azure 前替换 pending；契约必须保证任何时刻进入 SWA upload 的 production run 至多 1 个，并把被替换 run 视为 pre-Azure coalesce，而不是承诺无界队列或把它上报成 Azure deployment failure。PR validation 按 PR number、其他 validation 按 ref 使用独立 group，并可取消同目标旧验证。`workflow_dispatch` 必须提供 `required: true`、`type: choice`、默认 `validate` 的 `validate|production` 选项；只有 `main` push 或 `main` 且显式 `mode=production` 能执行唯一的 `Azure/static-web-apps-deploy@v1 action=upload` step，PR 和任何非 `main` 手动运行的 upload 数量必须为 0，引用 `#` 的 run-name 必须整体加引号且 notice 明确 validation-only 语义。production branch 选择权必须完全来自 workflow trigger、`deploy_production` job 和唯一 SWA upload step 的相同 hard condition，禁止给 SWA Action 传 `production_branch` 以制造无效或重复的分支选择。production build 必须通过 Node 24 的 `actions/upload-artifact@v7` 以 `frontend-dist` 名称、`packages/client/dist` 路径、`if-no-files-found=error` 和 1 天 retention 交给独立 main-only deploy job；该 job 必须依赖 build，并由 Node 24 的 `actions/download-artifact@v8` 以同名同路径直接恢复后再上传，禁止改变 artifact 名称、路径、归档或跨 job 行为。该 job 使用现有 OIDC 登录 Azure，按固定 CloudPhoto hostname 在配置的 resource group 中解析 SWA 并把运行时读取的 deployment token 以 masked step output 交给 upload action。workflow 禁止引用 repository `AZURE_STATIC_WEB_APPS_API_TOKEN`，完成迁移后必须删除该 secret，使所选 ref 仍含旧 workflow 的 stale branch 也无法获得生产凭据。`scripts/check-workflow-runtime-contracts.mjs` 必须从 active YAML（忽略注释与 shell 文本）验证 quoted run-name、concurrency、dispatch choice、artifact Action 精确 casing/ref/输入/跨 job handoff、任意大小写/ref 的 SWA action 总数、无 `production_branch`、单一 upload condition 与 token source，且前端 workflow 在安装依赖与 upload 前自检该契约。Production Health 必须以 `github.event.workflow_run.id` 与 `run_attempt` 查询 attempt-specific Frontend jobs，只有同一 attempt 的 `Deploy production` 确实 started 时才接受或拒绝 deployment conclusion；validation、build-before-deploy failure 与 pre-Azure coalesce 不得伪造生产红灯，真实 started deployment failure 仍必须按 run ID + attempt 逐个保留。
2.76 Production Health 部署身份契约：`workflow_run` 触发后必须以稳定的 `github.event.workflow_run.path` 识别 `.github/workflows/deploy-frontend.yml` / `deploy-backend.yml`，禁止使用会被自定义 `run-name` 覆盖的 `workflow_run.name`；并发分组、classifier env、expected SHA、identity gate 与报告使用同一 path。deployed SHA 的唯一来源必须是 `github.event.workflow_run.head_sha`；部署验证目录的 checkout ref、contract/full-smoke 脚本与事件报告必须绑定该同一值，禁止用健康 workflow 自身的 `github.sha` 或创建时已前移的当前 `main` 代替部署版本。允许先在隔离 controller 目录 checkout 健康 workflow 自身 SHA，用于运行当前 canonical classifier，并在 deployed revision 的 full smoke 后执行仅含两条 marker 请求的 identity smoke；controller 不得用未来 full-smoke 逻辑替代 deployed revision 自身 contract/smoke。canonical deployment 必须来自允许的 Frontend/Backend workflow path、`main` head branch、`push|workflow_dispatch` event、合法 40 位 SHA；Frontend 还必须有同一 run ID + `run_attempt` 中 started 且非 skipped 的 `Deploy production` job，禁止用省略 attempt 的 latest-jobs API 或健康 workflow 自身 run ID 混合重跑状态。分类器必须完整输出 canonical/started/check/reject 四个布尔值；任一缺失、check 无合法 SHA、check 与 reject 同时为 true、或 started 无 verdict 均必须在任何条件跳过前 fail closed。started failure、非 main upload 或 malformed identity 必须 fail closed；validation、build-before-deploy failure 与 pre-Azure coalesce 必须跳过。每个 production Frontend artifact 必须在 build 后写入只含 `{sha}` 的 `deployment.json`，不得加入 branch、URL、token 或其他上下文；SWA route 必须 `Cache-Control: no-store` 并排除 SPA fallback。成功 Frontend `workflow_run` 的 controller identity smoke 必须用 cache-busting query 同时读取主域代理和 SWA 直连 marker，只有两者精确等于 triggering `head_sha` 才可通过；缺失、旧/未来 SHA、额外字段、非法 JSON 或可缓存响应均失败，历史 deployed revision 即使自身 smoke 不认识 marker 也不得跳过此 gate。Backend、schedule 与手动 health 不得错误要求 Frontend marker 等于其 SHA；Frontend deployment、validation、Backend 与普通检查的并发组必须安全隔离，Frontend non-deployment 与真实失败按 run ID + attempt 独立保留。契约时间线必须覆盖 deployment A 完成后 main 已前移到 B、但 B 尚未部署：A 的部署验证 checkout/expected marker 仍为 A；B 部署完成后产生独立且只接受 B 的 health，不得出现“未来 commit 脚本验证旧产物”的假绿。
2.77 Frontend deployment ownership/receipt 契约：workflow-level production concurrency 只证明串行，不得被描述为同 SHA 幂等。Frontend 必须对每次 `main` push 创建候选 run，不得使用 paths filter；否则后续 deployment-irrelevant commit 会让旧 run 因失去 main-tip ownership 跳过，且没有替代 run。GitHub concurrency 仅保留一个 pending；若旧 SHA rerun 替换 current-tip pending，stale run 自身跳过仍会造成 orphan。因此 production job 必须仅在 initial/final/post-upload ownership 输出 `reason=stale-main` 时，以 job-scoped `actions: write` 和 `GITHUB_TOKEN` 执行 `gh workflow run deploy-frontend.yml --ref main -f mode=production`；该自愈只 dispatch main production，不允许非 main，不取消 active upload，重复 replacement 继续由 receipt gate 幂等收敛。`Deploy production` 必须在 Azure 登录前、upload 前和 upload 完成后调用 fail-closed ownership controller；三次都要求 `GITHUB_SHA` 为合法 40 位且精确等于 GitHub remote `refs/heads/main`。pre-upload 任一时点 main 已前移则本 run upload=0；post-upload 已前移则不得写 canonical receipt，并立即重排 current tip，防止 Health 把 upload 窗口内失去 ownership 的 attempt 当正式部署。controller 必须按 workflow 文件、main branch与 exact `head_sha` 完整分页查询历史 runs，不得只筛当前 success conclusion；对每个 run 必须从 attempt 1 扫到最新 `run_attempt`，并通过 attempt-specific jobs API 验证 `Deploy to Azure Static Web Apps` 与其后的 `Record canonical deployment receipt` 两步都成功，禁止最新失败 rerun 隐藏早期成功 receipt。历史 receipt 不能单独证明当前线上状态：只有 cache-busting/no-store 读取 `cloudphotos.top` 与 SWA 直连 marker 都精确等于 expected SHA 时才返回 `already-deployed`；合法 marker 不一致返回 `deployment-drift` 并允许当前 main tip 修复发布，marker 网络/缓存/JSON/shape 不可判定时必须 fail closed。未发现当前 receipt 的 main tip 才拥有正常 upload 权；旧 tip 返回 `stale-main`，不得获取 token后的最终 upload、不得取消 active SWA upload。Production Health 对 Frontend 必须从同一 attempt jobs 的明确 upload step 和 receipt step 分类：upload skipped 的 validation/coalesced success 为 non-deployment，upload started 但失败或 receipt 缺失必须 reject，只有 upload+receipt success 才 checkout deployed SHA 并产生 marker/full-smoke verdict。每个 Frontend completion 的 Health concurrency identity 必须含 triggering run ID + attempt，使重复成功的快速跳过检查不能取消真实 deployment verdict。契约必须覆盖 duplicate separate runs、same-run rerun attempt、other-run earlier successful attempt followed by failed rerun、older SHA superseded、stale rerun replacing current-tip pending、post-upload ownership loss、historical receipt with live drift、超过单页的 receipt、upload skipped、receipt missing 和 actual receipt success，并把报告输出标记为 `main-tip+serialized+coalesced`，禁止只断言 concurrency 字段。
2.77 工作区六视图页签契约：`AuthenticatedApp.tsx` 必须按 `WORKSPACE_TAB_ORDER` 渲染具名 `tablist`，六个原生 button tab 使用 `workspace-tab-<tab>` / `workspace-tabpanel-<tab>` 稳定 ID、`aria-selected`、`aria-controls`、`aria-labelledby` 与 roving tabindex；动态数量和筛选点只作视觉信息，不得进入可访问名称。聚焦页签时 ArrowLeft/ArrowRight 循环并自动激活，Home/End 跳到首尾，Enter/Space 保留原生按钮行为；点击、1–6 快捷键、拖放和键盘导航必须复用同一 `switchTab` 及 upload/download/delete/voice/batch/trash/maintenance/folderRename guard。guard 或 modal boundary 拒绝切换时 activeTab、selected 与焦点都留在原页签；接受后先聚焦目标，再用 `scrollIntoView({ block: "nearest", inline: "nearest" })` 只把窄屏横向页签条中的目标带入视口。每个 panel 的 `hidden` wrapper 必须位于 keyed ErrorBoundary 外层，使隐藏 panel 的恢复 fallback 也保持隐藏，失败不能泄漏到当前 panel 或卸载其他已挂载视图。默认、hover、selected、disabled 页签及数量徽章的普通文本对比度至少 4.5:1，focus ring 对相邻背景至少 3:1；selected 必须同时使用粗体、底边和底纹，不能只依赖颜色。Tab/Shift+Tab、方向键或 Home/End 把焦点带到自动隐藏的 Header/页签时必须先 reveal 导航并用 nearest 保持焦点矩形可见；导航聚焦、菜单/侧栏或任意 modal 活跃时禁止滚动再次隐藏，控件仍保持正常 Tab 可达且不得使用 inert。
2.78 已登录 Header 菜单、自动隐藏与子弹窗契约：GroupSwitcher 与用户菜单使用真实 button + `role="menu"` / `menuitem`、稳定 `aria-controls` / `aria-expanded` 和当前空间读屏状态；ArrowUp/ArrowDown 循环、Home/End、Enter/Space、Escape、Tab、外部点击及触发器焦点恢复必须一致，禁用项跳过且受守卫拒绝时空间、菜单和焦点不漂移。空间或头像触发器获得焦点、任一 Header 菜单打开、或菜单发起的弹窗仍活跃时必须立即 reveal 并锁定 Header，避免滚动或 transform 把焦点移出视口；只有焦点自然离开 Header 且菜单、弹窗均关闭后，后续下滚才允许再次隐藏。新建群组、群组设置、快捷键帮助、安装指引和添加管理员复用共享 stacked modal boundary，具备可见 dialog 标题、动态 Tab/Shift+Tab、嵌套隔离、仅向仍连接且可见触发器恢复焦点及 pending 关闭保护。已登录 Header 继续禁止常驻安装按钮，安装入口保留在用户菜单与设置应用页。
2.79 有界历史 GPS 恢复契约：设置页启动元数据维护前必须先执行不读取原图的只读估算，并在明确确认后才进入恢复。合法 finite/range GPS pair 不下载原图；NaN、越界、单边 pair 与缺失 GPS 且尚未完成当前 scan version 的非删除图片才是候选，缺少 takenAt 只在同一 GPS 候选读取中顺带恢复。服务端按 MIME 使用有界 Blob range，设置每文件硬上限、每页 8 MiB 总读取预算和请求截止时间；完整读取后从 EXIF 恢复合法 pair。只有确认完整扫描且无 GPS 时，才以 Blob ETag 条件写入清理后的 metadata pair 和完成标记；随后单独对账 photoLocations 索引，索引失败显式计入失败并可重试，不得宣称跨 Blob/Cosmos 原子。范围不足、预算跳过、超时或读取不完整不得清理或标记完成，后续任务仍可重试。进度和最终结果必须分别报告候选、恢复、真实缺失、无效清理、预算跳过和读取字节，workspace/auth 漂移或停止必须中断后续分页且不得把旧结果写入新空间。
2.80 PhotoCard 操作菜单键盘契约：普通模式照片主按钮必须同时支持 pointer contextmenu、Shift+F10 与 ContextMenu 键打开具名 `role="menu"`；键盘事件无坐标时以当前卡片矩形为锚点，并把菜单约束在视口。菜单 action 使用独立原生 `menuitem` button，并复用 shared menuKeyboard：打开后聚焦首个 enabled 项；ArrowUp/ArrowDown 循环、Home/End 首尾、Enter/Space 执行、Escape/外部点击关闭并只向仍 connected 的主按钮恢复焦点，Tab 关闭且不劫持浏览器后续焦点顺序。每个 action 执行前只对仍 connected 的主按钮恢复焦点。预览动作关闭 viewer 后继续恢复同一意图；batch selection、busy 或不允许的动作不得暴露菜单。收藏、删除、移动、GIF、拖放、touch 与 Header 安装入口约束保持不变。
2.81 胶囊存储与媒体类型安全：`capsuleStorage.ts` 纯 normalization 最多保留 100 个胶囊、每个 200 个记忆项、标题 40 字符、item name 1024 字符，拒绝非法日期、重复 ID、空项、NUL、HTTP(S) URL 和含 SAS 参数的名称；非数组或损坏 JSON 返回安全空列表并标记 discarded。新版 key 按 user/workspace 隔离，legacy user-only 数据仅 personal 可迁移；读、迁移、quota/permission 写失败必须显式显示 toast/页面错误。创建和删除只有 `setItem` 成功后才更新 React state。共享 `MediaThumb` 对 audio/* 只渲染图标和“音频”badge 的本地占位，不创建 img/video/audio 或网络请求；TimeCapsule 可选择并交给现有 viewer，AutoStory 则必须按 2.38 排除 audio/unknown/无派生封面视频。
2.82 私有 moments 本地授权作用域：离线浏览统计与诊断必须通过 `privateMomentsStore.ts` 使用 userId + role + personal/group workspace 派生键，并与照片列表/私有媒体共用 owner、auth generation、同步内存 reset 和 pending-write drain。所有 JSON 读取必须校验版本、结构、字节和条目上限；损坏、超限或异常对象 fail closed。旧版无归属 `cloudphoto_moments_*_v1` 键没有可信 owner，首次 scope preparation 或退出页刷新时必须删除而不得迁移给当前账号，只允许留下不含账号、照片名或诊断正文的清理标记。注销、401、无效会话恢复、切号或角色变化必须在认证 UI 更新前同步推进 generation、清空内存并删除照片列表、`photo-media-v1` 和 moments 当前/旧作用域数据；迟到写入必须因 owner/generation 不匹配而失效，不能重建旧全局键。localStorage 私有键必须先通过 `Storage.length` / `Storage.key()` 建立快照再删除，禁止依赖 `Object.keys(localStorage)` 的浏览器枚举行为。应用壳、precache 与 `app-code-v1` 保留；服务端 moments 同步和当前授权范围内的离线兜底不变。
2.83 工作区跳到主要内容契约：已登录页面 DOM 的首个焦点入口必须是动态 skip link，`href` 指向当前 active tabpanel 的稳定 ID；默认视觉隐藏，仅 `:focus-visible` 时显示且不造成布局位移。激活时必须受控聚焦当前 panel 并使用 nearest 滚动，不把整个页面横向居中；activeTab 变化后目标同步更新。侧边栏打开时 skip link 退出 Tab 序列，任何 aria-modal 活跃时继续由共享 inert/focus boundary 隔离后台。320/390px 与 200% zoom 下不得产生根级横向溢出。
2.84 记忆地图标记、详情与编辑无障碍契约：Leaflet 标记保持 22px 视觉圆点和原经纬锚点，但真实交互元素至少 44×44px；aria-label/title 只使用照片显示名，不含 URL/SAS，并支持 Tab、Enter、Space、focus-visible 与完整 listener cleanup。地图照片详情和 GPS 编辑通过 body portal + shared stacked modal boundary 提供 dialog/aria-modal/labelledby、明确初始焦点、动态 Tab/Shift+Tab、Escape/背景关闭和 connected-only 回焦；保存中禁止关闭，失败保留输入。编辑目标必须绑定 `workspace + photo name` 并从当前照片 inventory 重解析；目标离开当前分区、workspace 变化、关闭或卸载时必须 abort 等待中的 PATCH，迟到成功不得覆盖当前状态或偷焦点，分区移除时回焦到始终连接的地图 region 而非即将删除的 marker。位置搜索输入具备显式标签，坐标预览和结果使用真实 44px button，支持方向键移动、Enter 选择、Escape 关闭回焦，loading/空态使用 polite live status。清空、手动坐标、关闭、卸载或 workspace 变化必须 abort 请求并推进 generation，迟到结果不得覆盖新输入/loading；代理与直连缓存写入前复核 auth generation。手动坐标入口共用严格 finite/range parser，拒绝 91/181、NaN、partial 数值。320/390px 与 200% zoom 保持 44px 控件且不改变地图坐标。
2.85 PhotoCard 删除确认弹窗契约：直接删除按钮与 2.80 操作菜单删除动作必须复用同一 shared modal focus boundary，弹层通过 body portal 渲染为具名 `role="alertdialog" aria-modal="true"` 并引用不可撤销说明。打开后默认聚焦取消，Tab/Shift+Tab 动态循环，idle 时 Escape 或遮罩关闭；直接入口关闭后只向仍 connected 的删除按钮恢复，从操作菜单进入则向照片主按钮恢复，viewer 关闭后的意图链保持不变。删除请求进行中设置 aria-busy、禁用取消/确认并拒绝 Escape、遮罩和重复提交；settle 后才允许关闭。时间线、moments、FolderView、收藏/选择、拖放与 Header 安装入口约束不变。
2.86 WorkspaceSidebar modal drawer 契约：关闭状态可保留滑出动画，但必须设置原生 `inert` + `aria-hidden=true` 并退出 Tab 顺序/辅助技术树；打开后通过 body portal 呈现有可见标题的 modal drawer，复用 shared stacked modal boundary，初始焦点落关闭按钮，Tab/Shift+Tab 动态循环，Escape/遮罩关闭并只向仍 connected 的桌面 FAB 或紧凑触发器恢复。侧栏动作打开 Settings 等子层时 modal stack 只暴露顶层，关闭子层恢复原侧栏动作；Settings 与侧栏不得同时各自 inert 顶层。320/390px 和 200% zoom 下 drawer 保持视口内，内部 touch scroll 与筛选布局不退化。
2.87 私有近期分享链接授权作用域：`shareLinksStore.ts` 必须使用 userId + role 派生本地键，并与照片缓存/moments 共用 owner、auth generation、同步 reset 与 pending-write 生命周期。创建分享前捕获 generation，网络迟到响应在注销、401、无效会话、切号或角色变化后不得写回。旧全局 `cf_recent_share_links` 无可信 owner，必须 fail closed 删除而不得迁移给当前账号；损坏、超限或异常结构 JSON 同样删除。清理只影响浏览器近期公开链接记录，不删除云端托管分享、界面偏好、app-code/cache shell 或已含 workspace context 的文件夹路径。
2.88 私有 Workbox expiration 元数据清理：注销、401、无效会话恢复、切号或角色变化必须在删除 Cache Storage 的同时，定向清除 `workbox-expiration/cache-entries` 中 `photo-media-v1`、`cf-media-v1` 与私有照片列表 cacheName 的记录。数据库、对象仓库或索引缺失/变化不得触发整库删除、升级或创建，也不得阻断 Cache Storage 清理；清理必须幂等并在活动写入 drain 后重复执行，确保迟到记录最终消失。`app-code-v1`、未知 cacheName、应用壳/precache 与 service worker 注册必须保留；日志、测试与 changelog 不得输出存储 URL、查询串或 SAS。
2.89 分享创建与本地记录持久化契约：服务端成功创建公开链接后，本地 `localStorage` 配额、隐私模式或权限错误不得把整体操作误报为创建失败，也不得重试 `/photos/share` 这一非幂等 GET；链接仍须显示/复制，并单独提示“未保存到最近记录”。`shareLinksStore.ts` 写入必须返回区分 `stale-context`、`storage-unavailable`、无效条目与超限负载的显式结果；只有真实 auth generation 失效才抑制旧链接显示。list/remove/clear 必须捕获存储访问异常，Settings 不崩溃、不显示伪成功；所有写入仍受 owner + generation + storage owner marker 三重 fencing。
2.90 认证首屏布局与中文原生校验契约：生产 HTML 必须保持 `lang="zh-CN"`，登录/注册表单继续使用原生 `required`、`type="email"` 与既有 `autocomplete`，禁止 `noValidate`。`invalid` 时使用字段特定中文 `setCustomValidity` 或等效逻辑覆盖 `valueMissing` 与邮箱 `typeMismatch`；`input` 后必须可靠清除旧 custom error。无效表单依赖浏览器原生 focus/tooltip 且登录/注册 API 请求数为 0；密码长度、确认密码和 API 错误的既有页面内 alert 不变。`index.css` 与 `authenticated.css` 的 auth 样式区必须一致：320/390/500px 下 document 与 `.auth-page` 均满足 `scrollWidth === clientWidth`，长注册表单由 document root 纵向滚动，`.auth-page` 使用 visible overflow 且 `scrollHeight === clientHeight`，不成为双轴 nested scroll owner；1440px 装饰伪元素不得扩张 auth-page scroll bounds。登录/注册页签、所有输入框、密码显示按钮、提交和安装入口的实际 bounding box 均至少 44×44px，computed font 与 body 的 `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` 一致。`scripts/auth-layout-contracts.test.mjs` 锁定源码契约，`scripts/auth-layout-cdp.mjs` 必须在 320×800、390×844、500×800、1440×900 和 en-US Chromium 中验证几何、滚动归属、字体、中文提示、清错及零请求；login entry 继续遵守既有 36,000-byte static-cache gate，认证修复不得修改或放宽该预算。
2.91 照片 Blob 路径授权契约：所有接收客户端照片路径的下载、元数据更新、移动、motion-video、Moments 统计、公开分享、视频缩略图、软删除、恢复与永久删除路由必须调用同一 fail-closed authorizer；任何 Blob 属性读取、写入、复制、删除或 SAS 生成必须发生在授权之后。合法路径只能是至少四段的 `personal/{userId}/.../{filename}` 或 `groups/{groupId}/.../{filename}`，禁止空段、`.`、`..`、反斜线、未知命名空间、`_th_` 内部派生文件和 `_voice` 内部目录；个人路径仅 owner 或 admin 可访问，群组路径每次请求都重新验证 membership，游标或旧元数据不授予权限。上传、文件夹改名与文件夹分享必须复用普通照片目录约束，不能创建或移动内容到 `_voice`；managed share 打开时必须重新验证持久化 personal/group scope 和精确 folder prefix，并过滤所有非普通照片后才可生成 SAS。移动目标必须继续是同一 scope 中的正常照片路径，禁止借 folder 输入进入内部目录或跨 owner/group。`voiceMemoName` 只允许引用同一 scope 根下恰好一层 `_voice/{filename}`，元数据更新必须在持久化前拒绝跨 scope/普通文件夹/嵌套 voice 指针；列表必须对历史无效指针返回 undefined 且不得签发 SAS。源码 wiring 测试必须从 functions 目录发现 `get/getAll(name|blobName)` 路由，证明每个入口使用统一 authorizer，并覆盖未知 scope、内部路径、跨个人/群组移动、语音指针及 managed-share scope/prefix/filter；新增路径入口不能依赖手写清单。
2.92 认证后 API hedge lazy boundary：`apiRoutingPolicy.ts` 只能保留同步安全重放、代理探测 TTL 与昂贵读取分类，`raceHedgedAttempts`、HedgeAttempt/HedgeOutcome 及其 timer/abort/cancel/release 状态必须只存在于 `apiHedgePolicy.ts`。`http.ts` 不得静态导入该模块，只能在请求已满足 safe replay、alternate route 和 hedge delay 条件后 `await import("./apiHedgePolicy")`；chunk 首次加载必须复用 signal-aware wait，使 caller abort 与总超时不等待模块下载完成，登录/注册 POST 与默认未登录页面不得触发它。`App.tsx` 必须在已有 token 或登录/注册 intent 时与 AuthenticatedApp 并行预热，并把 chunk 失败交给 deployment recovery，禁止 silent catch。构建必须生成唯一 `apiHedgePolicy-<hash>.js`，该 chunk 不得进入 `index.html` preload 或 `sw.js` precache，入口继续受不可放宽的 36,000 B raw 门禁约束。源码、data-URL 行为和构建合同必须共同证明 slow healthy primary、faster fallback、caller abort、slow chunk abort、loser cancel、response-body release、昂贵 GET 排除及 lazy import rewrite 不退化。
2.93 登录线路补偿与认证前 PWA 更新恢复：`http.ts` 的 alternate-route replay 必须以 method + 精确规范化 endpoint 联合授权；除原有安全 GET/HEAD/OPTIONS 外，只允许 `POST /auth/login` 在线路 transport failure 或 502/503/504/521/522/523/524 后串行重试一次。登录不得进入 hedge、不得同时发起两条线路；`shouldHedgeApiRequest("POST", "/auth/login")` 必须保持 false，401/404 等业务响应即使浏览器残留旧 token 也不得触发 refresh 或登录重放。登录补偿的业务依据只能是凭据验证、幂等 `lastLoginAt` upsert 与无状态 token 签发；`POST /auth/register`、上传、分享创建及其他 unsafe write 必须维持一次调用且不得因别名或 query 绕过 endpoint gate。两条线路均失败时显示“登录服务暂时不可用，请稍后重试”，AbortError 继续显示登录 timeout，不得只归咎代理。认证前 `PwaInstallEntry` 必须在 mount 时读取持久化 `isPwaUpdateReady` 并订阅/清理 `PWA_UPDATE_READY_EVENT`；ready 时渲染可访问的“立即更新”原生按钮并调用现有 `activatePwaUpdate`，不得直接 reload 或绕过 dangerous-operation gate。missing updater、blocked、timeout 与异常必须显式提示；worker update/activation timeout 不得 hard refresh 回旧客户端。既有安装按钮、原生安装 prompt、手动步骤和最小 44×44 命中区域保持不变；登录/PWA regression 必须进入 Frontend workflow。

## 1. 目标

你是一个执行型 AI 工程师。你的任务是**尽可能原样复现**当前 CloudPhoto 项目，并指导用户完成 GitHub 与 Azure 的配置、部署与验收。

成功标准：

1. 本地可运行（前后端）
2. GitHub Actions 可自动部署
3. Azure 生产环境可用
4. 核心功能行为与本项目一致

---

## 2. 项目概览

- 前端：React 18 + TypeScript + Vite 5
- 后端：Azure Functions v4 + Node.js 24 + TypeScript
- 存储：Azure Blob Storage（照片）
- 数据：Azure Cosmos DB NoSQL（users/admins/groups/invites/sharelinks/moments）
- 鉴权：JWT access + refresh，客户端 401 自动刷新重试
- 访问凭据：DefaultAzureCredential（本地 Azure CLI，云上托管身份）
- CI/CD：GitHub Actions（前后端分离）

---

## 3. 必须复现的功能

### 3.1 账户与权限

1. 注册 / 登录 / 获取当前用户
2. JWT：短期 access + 长期 refresh
3. access 过期时，客户端自动 refresh 并重试原请求
4. 角色：admin / viewer
5. super admin 可提升其他用户为 admin

### 3.2 相册核心

1. 上传照片（多图、进度、大小和类型校验）
2. 时间线、文件夹、重要片段（独立 Tab）视图
2.1 重要片段须有独立筛选与排序（不可复用时间线筛选）
2.2 重要片段详情以互动指标为主：推荐值、互动热度、查看次数、分享浏览、最近查看、常看用户、高峰日
2.3 顶部 Tab 应显示关键数量（如时间线照片数、文件夹数、重点照片数），帮助用户快速理解每个视图的内容规模
2.4 首页应提供工作区级摘要信息（当前空间、照片数、文件夹数、收藏数、主题数、运行模式），帮助用户快速建立上下文
2.5 首页应提供活动流与运营洞察（最近上传、最近分享、同步状态、分享预警），让用户进入系统后立即知道“最近发生了什么”
2.6 首页应提供内容整理助手，至少覆盖“缺少主题”和“未分类照片”两类可直接处理的问题
2.7 首页上的快捷动作不能只停留在“切页签/切 Tab”，而应尽量直接滚动或定位到目标照片、目标管理区或目标链接，减少移动端用户额外滑动成本
2.8 首页默认视觉重心应放在照片内容本身；统计、运营洞察、活动流等内容应尽量轻量化或放入可折叠区域，避免长期占据首屏主要空间
2.9 首页相关 UI 应保持模块化实现，建议将首页焦点导航与洞察面板放在独立 home 组件目录中，而不是持续堆叠在 AuthenticatedApp.tsx 内
2.10 时间线与重要片段页应优先考虑“照片为主、工具为辅”的布局；筛选、快捷整理、分享洞察等更适合放在右侧可收起侧边栏，而不是长期占据照片流上方空间
2.11 右侧侧边栏应从页面右侧整段滑入，默认占据完整页面高度和部分横向宽度；开合动画需明确体现“从侧边弹出 / 收回”，不要做成底部抽屉感
2.12 侧边栏入口建议采用更强辨识度的胶囊悬浮组件，而不是普通小按钮
2.13 侧边栏展开时仍应保留一部分未被占据的主页面暗区，以强化“侧边面板”感；面板内容区域必须可独立滚动到底部
2.14 悬浮胶囊入口应作为独立组件实现，并与侧边栏主体分目录放置，避免 AuthenticatedApp.tsx 同时承担布局、侧边栏和悬浮入口三类职责
2.15 顶部主 Tab 在中小宽度下应避免换行破坏节奏，可通过横向滚动或紧凑 rail 方案保持可读性
2.16 设置页不应只是表单字段堆叠，需具备更明确的视觉层级，如 hero 区、卡片分组、信息网格和更稳定的操作按钮节奏
2.17 重要片段浏览量在前端展示时应尽量避免因异步返回顺序导致的数值回跳；客户端合并服务端响应时应保持计数单调稳定
3. 文件夹（含子文件夹）浏览与面包屑
4. 照片重命名、移动、下载
5. 桌面拖拽移动 + 移动端按钮移动
6. 批量操作：删除、移动、重命名
7. 收藏（星标）与“仅收藏”筛选
8. 搜索与筛选（名称、主题、上传者、日期、缺少主题、未分类）
8.1 若当前筛选无结果，页面必须提供一键恢复动作（如清空筛选、重置片段筛选、跳转到文件夹视图），不能只显示被动提示
9. 文件夹视图需接入浏览器/系统返回栈：返回键优先回退到上一级文件夹
9. 文件夹导航需接入浏览器/系统返回栈：返回键优先回退到上一级文件夹

### 3.3 回收站

1. 删除为软删除（metadata 写 deletedAt/deletedBy）
2. 回收站列表、恢复、彻底删除
3. 支持“全部恢复”和“清空回收站”
4. 恢复后相册自动刷新
5. 恢复后显示上传日期（createdAt），不是恢复时间
6. 单张、全部、文件夹级恢复和永久删除必须共用同步 gate 与串行可停止 runner；运行中所有桌面/移动入口禁用，并显示操作名称、done/total、failed 与百分比
7. 停止、卸载或空间漂移后取消当前请求，不启动下一项，重新读取远端回收站并保留已停止统计；已完成的永久删除不得显示为已回滚
### 3.4 群组与邀请

1. 创建/编辑/删除群组
2. 群成员角色：admin/member
3. 邀请入群（token、过期时间、接受/拒绝）
4. 接受邀请后自动切换到该群组

### 3.5 分享（过期链接）

1. 为单张照片创建分享链接
2. 可选过期时间（例如 1h / 24h / 3d / 7d）
3. 复制链接到剪贴板（一键复制）
3.1 文件夹分享必须通过独立弹窗选择有效期，而不是在工具栏内长期展示时长下拉
4. 当 Clipboard API 受限时自动走兼容复制兜底，仍失败才允许手动复制
5. 权限校验：个人空间仅本人可生成，群组仅成员可生成
6. 具备可维护的云端分享链接管理：支持提前失效、延长有效期
7. 每个分享链接保留可查询信息：创建时间、浏览量、最近访问时间、状态
8. 云端分享链接支持按状态（有效/已过期/已失效）筛选与按文件名搜索
9. 延长有效期支持多档时长（至少包含 1h / 24h / 3d / 7d），而不是固定 24h
10. 分享链接维护与访问统计需具备并发一致性：并发更新不能丢失计数，冲突写入需可检测

### 3.5.2 重要片段洞察（跨设备）

1. 重要片段浏览记录必须服务端持久化，不可仅保存在 localStorage
2. 至少提供两条接口：
	- `POST /api/photos/moments/insights`（批量拉取，body 传 `photoNames[]`，避免超长 URL）
	- `POST /api/photos/moments/view`（记录一次浏览）
3. 洞察写入需有并发保护（ETag 或同等级乐观并发）
4. 洞察需记录：totalViews、lastViewedAt、viewers 计数字典、dailyViews 计数字典
5. 推荐值与互动热度需可复现，推荐公式至少包含：收藏、主题、新近度；热度至少包含：推荐值、浏览权重、最近查看加成（分享访问作为独立指标）
6. Moments 文档 `id` 必须使用 Cosmos 安全字符编码（如 `base64url(photoName)`），不能使用会产生 `/` 的普通 `base64`
7. 当服务端 moments 临时不可用时，前端可做本地刷新级兜底，但一旦服务端可用，热度必须以服务端共享值为准，不能长期各端各算

### 3.5.1 并发一致性（图片与分享）

1. 图片元数据更新、移动、软删除、恢复、彻底删除需采用乐观并发控制（例如 ETag + If-Match）
2. 并发冲突时服务端返回 409，客户端统一提示“资源已被他人修改，请刷新后重试”
3. 对可重试冲突应执行有限重试（建议最多 3 次），避免无限重试

### 3.6 详情弹窗可用性

1. 超长文件名必须显示为省略形式，不得挤压功能按钮
2. “重命名/下载/分享”等操作按钮在长文件名场景下仍可完整点击

### 3.7 PWA（第一阶段）

1. 前端可作为网站正常打开，也可安装成 PWA App
2. 具备 manifest + service worker + 版本更新提示
3. 支持安装引导（桌面/Android），iOS 提供“添加到主屏幕”引导
4. 本地开发模式默认关闭 SW 注入，避免调试阶段循环刷新
4. 本地开发模式默认关闭 SW 注入，避免调试阶段出现循环刷新
5. 普通网页版应优先即时更新，不应长期受 SW 缓存拖慢；已安装的 standalone App 才保留持久 SW 行为
6. 设置内应提供独立“诊断”页签，用于显示前端版本、构建时间、SW 注册数、本地 moments 缓存条数、moments 持久化状态
7. 当存在上传/下载/批量删除/语音备注/批量照片 mutation 任务时，PWA 更新必须等待用户在任务完成后主动触发，不得后台自动刷新

### 3.8 传输稳定性

1. 上传/下载、批量删除、语音备注或批量照片 mutation 进行中阻止应用内页面/个人与群组空间切换
2. 上述任务进行中刷新或关闭页面触发浏览器离开确认
3. 下载与上传默认保持原图，不做压缩

### 3.9 视频上传文件选择器

1. 文件输入 `accept` 属性必须包含 `video/*`（及 `image/*`），确保用户可以从文件选择器中选择视频文件
2. 服务端 `ALLOWED_UPLOAD_MIME` 已包含视频格式，仅前端文件选择器限制需修正

### 3.10 语音备注（F1）

1. 用户可在任意照片/视频详情弹窗中录制语音备注（按 🎤 语音按钮展开面板）
2. 录音使用浏览器原生 `MediaRecorder` API；Chrome/Android 使用 `audio/webm`，Safari/iOS 使用 `audio/mp4`
3. 录音文件通过现有 `/photos/upload` 接口上传，上传目标文件夹为 `_voice`（与照片所在 groupId 关联）
4. 上传完成后通过 `/photos/metadata` PATCH 将语音文件名（`voiceMemoName`）写入照片 blob 元数据
5. `listPhotos` 接口：`_voice` 文件夹内的 blob 必须过滤不返回；照片对象中附带 `voiceMemoName` 和 `voiceMemoUrl`（SAS URL）字段
6. 详情弹窗语音面板：有备注时显示 `<audio>` 播放器；无备注时显示"开始录音"按钮；录音中显示红色停止按钮
7. 可删除语音备注（PATCH `voiceMemoName = ""`，清除元数据）
8. 操作栏按钮：有备注时显示 **🎤 备注✓**，录音中显示 **🔴 录音中**（配红色闪烁动画）

---

## 4. 代码结构要求

目标结构（关键）：

- client
- server
- .github/workflows/deploy-frontend.yml
- .github/workflows/deploy-backend.yml
- README.md

后端函数入口应注册照片、回收站、认证、群组、邀请相关函数。

建议目录分层（新增功能必须遵循）：

- Client 侧按功能域组织（例如 `client/src/features/share/`）
- Server 侧按能力域组织函数（例如 `server/src/functions/share/`）

---

## 5. Azure 资源与配置

## 5.1 资源清单

必须创建：

1. Resource Group
2. Function App（Linux，Node 24）
3. Static Web Apps
4. Storage Account + Blob Container（如 photos）
5. Cosmos DB NoSQL + Database + 容器：users/admins/groups/invites/sharelinks/moments
6. （可选）Azure Communication Services（邮件邀请）

## 5.2 RBAC

Function App 的系统分配托管身份需要：

- Storage:
1. Storage Blob Data Contributor
2. Storage Blob Delegator

并确认 Storage Account 网络策略符合分享场景：

1. 若需要对公网分享，需允许公网可达（或有等效对外访问路径）
2. 若仅私网可达，外部用户打开分享链接会失败/404

- Cosmos:
1. Cosmos DB Built-in Data Contributor（数据平面）

注意：Cosmos 容器创建通常属于管理平面，生产上请先手工建好容器。

## 5.3 Function App 应用设置（示例键名）

- FUNCTIONS_WORKER_RUNTIME=node
- STORAGE_ACCOUNT_NAME=<your-storage-account>
- STORAGE_CONTAINER_NAME=<your-blob-container>
- COSMOS_ENDPOINT=<your-cosmos-endpoint>
- COSMOS_DATABASE=<your-db>
- JWT_SECRET=<strong-random-secret>
- SUPER_ADMIN_USERNAME=<your-super-admin-username>
- APP_BASE_URL=<your-frontend-url>

邀请邮件可选：

- ACS_ENDPOINT
- ACS_CONNECTION_STRING
- ACS_SENDER_ADDRESS

本地建议：

- AZURE_TENANT_ID=<tenant-id>

---

## 6. GitHub 配置与工作流

## 6.1 必填 Secrets

后端部署：

- AZURE_CLIENT_ID
- AZURE_TENANT_ID
- AZURE_SUBSCRIPTION_ID
- AZURE_RESOURCE_GROUP
- AZURE_FUNCTIONAPP_NAME

前端部署：

- AZURE_CLIENT_ID（与后端共用、允许 main branch OIDC）
- AZURE_TENANT_ID
- AZURE_SUBSCRIPTION_ID
- AZURE_RESOURCE_GROUP
- VITE_API_BASE（例如 https://<function-app>.azurewebsites.net/api）

不得保留 `AZURE_STATIC_WEB_APPS_API_TOKEN` repository secret；首次 OIDC 前端部署成功后立即删除旧 secret，生产 job 运行时从 Azure 读取并 mask deployment token。

## 6.2 工作流行为

- deploy-backend.yml
1. 仅 server 相关变更触发
2. 安装依赖、构建、Azure 登录
3. 打包并 zip 部署到 Function App

- deploy-frontend.yml
1. 仅 client 相关变更触发
2. 注入 VITE_API_BASE 构建，并用 Node 24 的 `upload-artifact@v7` / `download-artifact@v8` 以 `frontend-dist` 在同 workflow 跨 job 传递
3. 仅 main production job 通过 OIDC 解析 SWA deployment token 并发布；production 分支由 workflow/job/step 条件锁定，不向 SWA Action 传 `production_branch`；PR 与分支手动运行只验证

建议使用 OIDC（federated credentials），不要存储 SP 密码。

---

## 7. 本地开发步骤（标准）

1. 克隆仓库并安装依赖
2. 在 server 配置 local.settings.json（仅本地）
3. 登录 Azure CLI：az login
4. 启动后端：func start
5. 启动前端：yarn dev
6. 验证前端 /api 能正确代理到本地函数

---

## 8. 数据与元数据约束

## 8.1 Cosmos 容器

- users（/id）
- admins（/id）
- groups（/id）
- invites（/id）
- sharelinks（/id）

- moments（/id）

说明：

1. `sharelinks` 仅保存分享链接记录
2. `moments` 容器仅保存重要片段洞察（浏览次数、按天统计、常看用户）

## 8.2 Blob metadata

- originalName
- subject
- favorite（"1"/"0"）
- createdAt
- createdBy
- lastModifiedAt
- lastModifiedBy
- deletedAt
- deletedBy

如果历史对象没有 createdAt，软删除时补齐（优先 blob createdOn）。

---

## 9. 验收清单（必须逐项打勾）

1. 注册/登录/刷新令牌正常
2. 上传、下载、重命名、移动正常
3. 新建空文件夹刷新后不丢失
4. 桌面拖拽可移动，手机端按钮可移动
5. 回收站恢复/全部恢复/清空可用
6. 恢复后日期显示上传时间
7. 收藏与仅收藏筛选可用
8. 批量重命名可用
9. 分享链接可生成、可复制、带过期时间
10. 分享链接可在设置中提前失效或延长有效期
11. 分享链接可查看创建时间、浏览量、最近访问时间
11.1 重要片段浏览统计支持跨设备同步，且浏览量更新使用共享计数而非单页本地状态
11.2 重要片段筛选项与展示指标一致（如热度、推荐值、浏览量、分享量）
12. 超长文件名时，详情弹窗操作按钮不会被遮挡
13. 邀请链接接受后可入组并切换群组
14. 前后端 CI/CD 均可通过并部署成功
15. 网站模式与 PWA 安装模式均可用
16. 安装后可收到更新提示并完成升级
17. 上传/下载过程中切换页面会被阻止，刷新会提示确认
18. 文件夹内按返回键会回到上一级文件夹，而不是直接退出应用
19. 并发修改同一照片/分享链接时，系统会返回 409 且前端显示统一冲突提示
20. 时间线排序切换（最新/最早）chip 可用
21. 键盘快捷键 1/2/3/S/Backspace 在非输入框状态均可正确触发
22. 周报卡片显示存储用量（非硬编码，基于实际 blob size 聚合）
23. 切换群组时时间线筛选自动清空

---

## 10. 常见故障排查

1. 邀请创建 500
- 检查 invites 容器是否存在
- 检查函数身份是否有 Cosmos 数据平面权限

2. 邀请链接 404
- 检查 APP_BASE_URL
- 检查是否正确回退 Origin 头

3. 本地 Cosmos 401/403
- 检查 az login 的租户是否正确
- 设置 AZURE_TENANT_ID

4. 恢复后相册无变化
- 检查恢复动作后是否触发相册刷新

5. 文件名显示为完整路径
- 前端应显示 basename，不显示完整 blob path

6. 移动端不能拖拽
- 这是浏览器限制，必须提供触控替代入口（按钮+选择目标）

---

## 11. 交付方式要求（给执行 AI）

每一批实现都必须：

1. 先改代码
2. 跑构建（前后端）
3. 给出变更摘要
4. 给出验证结果
5. 若失败，附排查与修复建议

禁止行为：

1. 提交真实密钥/连接串
2. 省略权限校验
3. 省略错误处理与回滚逻辑

---

## 12. 推荐执行顺序（如果从零开始）

1. 骨架项目 + Auth
2. 照片上传/列表/下载
3. 文件夹与移动
4. 回收站
5. 群组与邀请
6. 收藏 + 筛选
7. 批量重命名
8. 分享链接
9. CI/CD + Azure 部署
10. 回归测试与文档完善

---

## 13. 给另一个 AI 的启动提示词（可直接复制）

你现在是 CloudPhoto 项目的实现工程师。请严格按 AI_REPRO_SPEC.md 实施，目标是复现当前项目行为并可在 Azure 上部署。每完成一个功能批次必须：给出代码变更、运行构建、报告结果。优先保证功能正确性和权限安全，不要提交任何真实密钥。若遇到 Azure 或 GitHub 配置缺失，请明确列出需要用户补充的参数与 Secrets 键名。
