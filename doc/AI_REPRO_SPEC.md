# AI_REPRO_SPEC
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
2.28 PhotoCard.tsx 与 MediaThumb.tsx 中视频网格只能使用已持久化的 thumbnail/preview `<img>`，缺失时显示本地 placeholder，不得挂载原始 `<video>`；右下角显示 photo-video-badge (.▶)。用户明确打开视频查看器后才以 `preload="metadata"` 获取起播元数据。
2.29 文件夹路径刷新持久化：FolderView 使用惰性 useState 初始器从 localStorage 直接读取 currentPath 和 extraFolders，确保刷新页面后立即回到上次所在文件夹，而不是重置到根目录；persist effect 使用 hydratedContextRef 防止首次渲染覆盖
2.30 删除确认弹窗必须通过 createPortal(…, document.body) 渲染，避免受父元素 transform/overflow 影响导致 position:fixed 偏移出视口
2.31 批量删除与清空回收站进度：AuthenticatedApp.tsx 中新增 deleteProgress state（done/total/label）；handleBatchDeleteWithProgress 顺序调用 deletePhoto 并逐步更新进度；transferring 条件包含 deleteProgress !== null；transfer-banner 新增 deleteProgress 分支（🗑️ 图标 + 百分比 + 进度轨道）；TrashView 内部有独立 emptyProgress state，渲染 .trash-empty-progress 内联进度块（复用 transfer-banner-* CSS 类）；清空过程中"清空回收站"和"全部恢复"按钮 disabled
2.32 WhatsNewPopup：src/components/WhatsNewPopup.tsx；CHANGELOG 数组含 id/date/icon/title/desc 字段；getRecentEntries() 过滤 3 天内条目；localStorage key cf_whats_new_seen 存储最近已见日期；仅当有比已见日期更新的条目时展示；createPortal 渲染到 document.body；requestAnimationFrame 驱动倒计时进度条（100→0），AUTO_DISMISS_MS=10000；关闭后写入 latestDate 到 localStorage；新功能只需向 CHANGELOG 头部追加条目
2.33 详情弹窗移动端垂直居中：media query 内 .modal-content 使用 margin: auto（替代 margin: 0）；max-height 改为 none；overlay 保持 align-items: flex-start + overflow-y: auto，实现"有空间时居中、超高时从顶部滚动"的标准 flex 模式
2.34 视频缩略图居中裁剪：.photo-thumbnail video 与 img 共用同一规则块，均设置 width:100%; height:100%; object-fit:cover; object-position:center；hover 缩放同步适用于 video 元素
2.35 历史上的今天（OnThisDayCard）：src/components/OnThisDayCard.tsx；Props: photos: Photo[], onJumpToPhoto?: (name: string) => void；过滤 photos 中月日与今天一致且年份小于当年的照片；按年分组，显示缩略图 + 「X年前」标签；默认展示前 6 张，「+N」按钮展开；整体渲染在 AuthenticatedApp.tsx 时间线分支的 PhotoGallery 上方；CSS 前缀 .otd-*
2.36 记忆地图（MemoryMap）：src/components/MemoryMap.tsx；lazy 加载（dynamic import）；使用 leaflet 直接操作（非 react-leaflet）；在 useEffect 中 import("leaflet").then(L => ...) 初始化地图；OpenStreetMap tiles；markers 为 L.divIcon（含照片缩略图，class map-photo-marker）；点击 marker 底部弹出详情面板（.memory-map-detail）；Props: photos: Photo[], onViewPhoto?: (name: string) => void；仅展示 p.gpsLat && p.gpsLon 的照片；Tab 按钮显示含 GPS 照片数量；新增 ViewTab: "map"；CSS 前缀 .memory-map-* .map-photo-marker
2.37 时光胶囊（TimeCapsule）：src/components/TimeCapsule.tsx；lazy 加载；localStorage key cf_capsules_{userId}；capsule 结构: { id, title, photoNames, unlockDate, createdAt }；锁定/解锁分区；创建弹窗使用 createPortal；新增 ViewTab: "capsule"；CSS 前缀 .capsule-*
2.38 自动故事（AutoStory）：src/components/AutoStory.tsx；lazy 加载；选择文件夹/全部 + 过渡效果(fade/slide/zoom) + 播放间隔(2-10s)；全屏播放器通过 createPortal；键盘 ←→/Esc 支持；顶部进度段可点击；背景为当前图片的 blur 大图；新增 ViewTab: "story"；CSS 前缀 .story-*；@keyframes story-fade-in/story-slide-in/story-zoom-in
2.39 GPS 数据管道：客户端上传时用 exifr.gps(file) 提取 latitude/longitude，作为 gpsLat/gpsLon 查询参数传给 uploadPhoto；服务端 uploadPhoto.ts 从 request.query 读取并写入 blob metadata；listPhotos.ts 在返回的照片对象中携带 gpsLat/gpsLon 字段；Photo interface 新增 gpsLat?: string; gpsLon?: string;
2.40 EXIF 拍摄时间时区：exifr 内部将 EXIF 日期时间视为 UTC，因此使用 getUTCFullYear/Month/Date/Hours/Minutes/Seconds 格式化为不含 Z 后缀的 naive datetime 字符串（如 "2024-05-20T14:30:00"）；客户端 new Date("2024-05-20T14:30:00") 按本地时区解析，UTC+8 用户显示 14:30 而非 22:30
2.41 排序键切换（takenAt / uploadedAt）：PhotoGallery 新增 sortKey prop（"taken" | "uploaded"，默认 "taken"）；groupByDate 和 flatPhotos useMemo 均按 sortKey 选择日期字段——"taken" 使用 photo.takenAt ?? photo.createdAt ?? photo.lastModified，"uploaded" 使用 photo.createdAt ?? photo.lastModified；AuthenticatedApp.tsx 新增 photoSortKey state，工具栏新增「📷 拍摄时间」和「☁ 上传时间」chip 切换按钮
2.42 历史照片元数据回填：POST /api/photos/backfill?limit=30[&groupId=<id>&cursor=<opaque>]，limit 必填，缺失时返回 400 防止旧客户端把单页误报为全部完成；每次最多列出一个 Azure Blob 页并排除 `_th_` derivative，下载本页缺少 takenAt 或 GPS 的原始照片，用 exifr.parse + exifr.gps 提取并以 ETag 条件写回；游标绑定 `metadata|thumbnails + personal user|group` 上下文，客户端 auth generation 变化后终止后续批次；GPS 缓存从写入后的最新 Blob metadata 对账到 photoLocations Cosmos，Blob ETag 改变时只按 Cosmos ETag 撤销本次迟到写入，防止并发编辑/删除被覆盖；返回 { processed, updated, failed, hasMore, cursor? }，客户端持续分页并聚合统计；在 SettingsDialog「📱 应用」Tab 新增「历史照片回填」卡片，含加载状态和结果/错误展示
2.42a 上传批次授权、空间与幂等：客户端在批次开始时捕获 auth generation、显示名和 groupId，订阅认证与当前空间变化并用同一 AbortSignal 终止当前 XHR、暂停/离线等待、重试和剩余文件；认证/空间变化或 AbortError 不进入三次网络重试，进度、照片追加、视频封面和最终刷新也校验原空间。每个文件在重试循环外生成一次 crypto.randomUUID() 作为 uploadId；服务端校验 UUID，以 `{scope}/{folder}/{uploadId}-{safeName}` 为稳定 Blob 名并用 ifNoneMatch=* 条件创建，412 或已存在时从当前 Blob 对账 GPS Cosmos 后返回同一 Blob；groupId 上传必须通过 isGroupMember。带 uploadId 的代理上传在网络错误、超时、缺失路由或网关错误时只直连补偿一次。
2.43 批量修改拍摄时间：PhotoGallery 批量模式工具栏新增「修改时间 (N)」按钮；展开内联 datetime-local 输入框；handleBatchSetTakenAt 遍历 selected 集合调用 updatePhotoTakenAt，使用本地时区 naive datetime（不调用 toISOString()）
2.44 批量修改 GPS 位置：PhotoGallery 批量模式工具栏新增「修改位置 (N)」按钮；展开内联纬度/经度输入框；handleBatchSetGps 校验 ±90/±180 范围后遍历 selected 调用 updatePhotoGps；通过 onGpsUpdate prop 回调同步 App state 中的 photos 数组
2.45 重要片段 Top 20 限制：PhotoGallery 新增常量 MOMENTS_MAX = 20；momentCards useMemo 中将 ranked.slice(0, visibleCount) 改为 ranked.slice(0, MOMENTS_MAX)；hasMore 加入 !momentsMode 条件，重要片段视图不显示「加载更多」按钮
2.46 change file 管道：changes/ 目录下所有文件命名规范为 YYYY-MM-DD-id.json，文件内 id 字段与文件名（去掉 .json）一致；scripts/create-change.mjs 支持 stdin 管道模式（!process.stdin.isTTY 时读 JSON 跳过交互）；deploy-frontend.yml 在 Build 步骤前执行 node scripts/collect-changes.mjs 自动重建 changelog.json；sync-changelog.yml 在 changes/** push 时自动同步到 Cosmos DB changelogs 容器
2.47 登录首屏分包：AuthenticatedApp.tsx 必须通过 React.lazy 动态导入 PhotoGallery，未认证状态不请求图库 chunk；认证工作区挂载后 useEffect 立即调用同一 loader 预载，使图库代码下载与照片列表请求并行。时间线与重要片段均提供「正在加载照片视图…」Suspense fallback；构建产物必须包含单独的 `PhotoGallery-<hash>.js`。Workbox 的应用代码预缓存仅包含 index.html、入口 JS/CSS、React vendor、PWA 注册和 workbox-window，另保留安装所需 manifest/图标；其他 `/assets/` chunk 使用 `app-code-v1` CacheFirst 在首次请求后缓存，PhotoGallery 不得出现在 sw.js precache manifest。
2.48 认证工作区分包：App.tsx 只保留 ToastProvider、AuthProvider、AuthPage、会话门和 Suspense/ErrorBoundary；完整工作区及 GroupProvider 位于 React.lazy 加载的 AuthenticatedApp.tsx。模块加载器缓存同一个 Promise：已有 token 在模块初始化时预载，登录与注册提交通过 AuthPage onAuthIntent 在 API 请求前预载。chunk 失败时必须显示可刷新恢复 UI；构建产物必须存在 `AuthenticatedApp-<hash>.js`，且该文件不得进入 sw.js 预缓存。
2.49 认证前样式分包：main.tsx 入口继续加载 index.css，但该文件只能包含全局 reset、AuthPage、AppSplash 和工作区 chunk 恢复样式，源码保持在 20 kB 内且不得出现 app-header、photo-grid 或 workspace-sidebar。AuthenticatedApp.tsx 单独导入 authenticated.css，构建必须生成 `AuthenticatedApp-<hash>.css`；登录入口 CSS 必须小于 12 kB，认证工作区 CSS 与 JS 均不得进入 sw.js precache，并在首次认证意图后由 `app-code-v1` 缓存。index.css 与完整工作区中的 Auth Page 区段必须保持一致，防止同一会话注销后登录页样式漂移。
2.50 认证服务边界：AuthContext.tsx 必须直接从 authApi.ts 导入 AuthUser/AuthResponse 与登录、注册、会话、资料 API，并从 http.ts 导入 token 生命周期工具，禁止通过 photoApi.ts 兼容 barrel。构建后的 `index-<hash>.js` 必须小于 32 kB，且不得包含媒体线路超时、候选预载或媒体 fallback 错误文本；这些照片工作区 helper 只能随 AuthenticatedApp chunk 加载。
2.51 私有照片缓存生命周期边界：AuthContext.tsx 只能从 privatePhotoCacheLifecycle.ts 获取账号/角色归属准备和清理能力，禁止直接导入 photoListCache.ts。生命周期模块必须在清理前同步递增 generation、同步通知内存缓存 reset，并等待已注册的持久化写入后再删除照片列表及私有媒体 Cache Storage；photoListCache.ts 仅保留认证后需要的列表读写、过期裁剪和序列化。构建后的 `index-<hash>.js` 必须小于 30 kB，且不得包含照片列表虚拟缓存路径或读写失败文本。
2.52 照片策略模块边界：http.ts 必须从 authScope.ts 获取 JWT authorization snapshot，从 apiRoutingPolicy.ts 获取安全重放、代理探测 TTL 和 hedge 竞速；禁止导入 photoLoadingPolicy.ts。photoLoadingPolicy.ts 仅保留照片列表 cache key、发布代次、刷新节流和媒体缓存资格规则。构建后的 `index-<hash>.js` 必须小于 29.7 kB，且不得包含照片列表 `:group:` cache key 片段；行为测试必须在拆分后继续覆盖角色隔离、路由竞速、取消和昂贵读取不 hedge。
2.53 注册表单意图边界：AuthPage.tsx 只保留默认登录表单，并通过缓存同一个 Promise 的 React.lazy loader 加载 RegisterForm.tsx；注册 Tab 的 pointer hover、键盘 focus 与实际切换均触发预载。RegisterForm 挂载后在登录/注册 Tab 间保持字段状态，注册提交仍必须在 API 请求前调用 onAuthIntent 预载认证工作区。构建必须产生唯一 `RegisterForm-<hash>.js`，该 chunk 不得进入 sw.js precache；登录入口必须小于 27.6 kB，且不得包含「正在创建账号…」注册提交文案。
2.54 媒体快路径：时间线、重点片段和文件夹只允许前 `GALLERY_EAGER_MEDIA_COUNT = 6` 张派生图使用 eager/high priority，其余保持 lazy；后台直连/代理竞速改变首选线路后，已加载照片状态及卡片 URL 必须重路由。普通图片查看器首次打开只能按 thumbnail → preview → original fallback 选择，不得因高 DPR 自动下载 original，且主图使用 high priority；视频查看器在用户打开后使用 metadata preload。下载接口必须校验 `personal/{userId}` 或已加入的 `groups/{groupId}` 路径，拒绝 derivative/voice 内部 Blob，接收清洗后的 filename 并直接签发附件 SAS，不读取 Blob properties；客户端票据缓存按 auth generation 隔离、最多 8 条，查看器打开后预热，点击不得等待媒体 HEAD。视频上传开始前必须启动本地封面提取，原 Blob 创建后再持久化封面。
2.55 更新弹窗关键路径延后：AuthenticatedApp.tsx 禁止静态导入 WhatsNewPopup；必须通过 `const loadWhatsNewPopup = () => import("./components/whats-new/WhatsNewPopup")` + `lazy(loadWhatsNewPopup)` 形成独立 chunk。`loading=true` 时不允许挂载弹窗组件（因此不得触发 fetchChangelogs），`loading=false` 后仅允许通过 `requestIdleCallback({ timeout: 2000 })` 调度挂载，并提供 `setTimeout(..., 0)` 兼容 fallback。切回 loading 或组件卸载必须 `cancelIdleCallback`/clearTimeout 并通过 requestId guard 拒绝迟到挂载。构建产物必须存在唯一 `WhatsNewPopup-<hash>.js`，且该 chunk 不得进入 sw.js precache。
2.56 PWA 更新激活路径与传输守卫：`main.tsx` 的 `registerSW().onNeedRefresh` 禁止调用 `updateSW(true)` 或 `location.reload`，只能持久化全局 `__CF_PWA_UPDATE_READY__` 并派发 `cloudphoto-pwa-update-ready`。AuthenticatedApp 初始 `updateReady` 必须读取该 flag，后续通过事件同步，保证事件早于登录/工作区挂载时仍可恢复提示。用户显式点击是唯一激活路径；`uploadProgress !== null || downloading || deleteProgress !== null` 任一成立时，更新按钮 disabled 且文案明确「传输完成后更新」，并阻止激活 waiting worker / 刷新页面。
2.57 语音备注全局传输守卫：时间线、重要片段、文件夹三个长期挂载视图需按 source key（timeline/moments/folder）独立上报 `voiceState`（idle/recording/uploading）；顶层必须聚合并派生统一 `transferring`，其中 recording 与 uploading 都算 active。任一 source 卸载时必须清理为 idle，且一个 source 清理不得覆盖另一个仍 active 的 source。统一守卫用于 beforeunload、切 Tab、切群组和 PWA 更新按钮；transfer banner 必须新增语音分支，区分「录音中，请先结束录音」与「语音备注上传中，请勿关闭页面」，不得误报为下载中。
2.58 最近更新模态键盘契约：WhatsNewPopup 可见时保存当前焦点并在挂载后聚焦关闭按钮；Escape 触发既有关闭动画，Tab/Shift+Tab 必须按当前可见控件重新计算并首尾循环，展开/折叠后仍成立。用户键盘聚焦或交互必须取消 idle/fade 计时器并 pin 弹窗；关闭动画完成或卸载时仅当原元素仍 `isConnected` 才恢复焦点。所有 idle/fade/close/initial-focus timer 在卸载时清理且异步回调必须有 mounted guard。条目摘要必须为 `button type="button"`，详情与修复折叠区使用稳定 `aria-expanded`/`aria-controls`/`id` 关联，弹窗通过 `aria-labelledby` 引用可见标题。不得改变 2.55 的 lazy chunk、照片 loading 后 idle 挂载、迟到任务 guard 与 SW precache 排除契约。
2.59 已登录 Header 安装入口约束：AuthenticatedApp 的 `.app-header` 禁止渲染 PWA 安装按钮或保留 `.header-install-button` 样式，避免挤压群组切换、照片数量和用户菜单。PWA 安装仍需在登录页、用户菜单与「设置 → 应用」中可发现，取消原生安装提示后的文案必须指向这些真实入口。
2.60 批量照片 mutation 全局守卫：新增纯逻辑 `batchMutationState.ts`，source 固定为 timeline/moments/folder，operation 至少携带 id、kind(rename/time/location/move)、done、total、failed。start 可替换同 source 的旧 token；progress/finally 只有 token 匹配才可更新或清理，因此一个 source 完成不得影响其他 source，旧操作迟到事件不得清理新操作。PhotoGallery 覆盖 rename/time/location，FolderView root 必须向 FolderContent 透传并覆盖 move/rename/time/location；第一条请求前上报 start，所有 item settled 后的 finally 上报 finish，卸载 cleanup 不得提前报 idle，卸载后不得 setState。同步 ref gate 阻止双击重入；BatchOperationsBar 通过真实 disabled/aria-busy 禁用选择、全选、rename/time/location/delete/LocationSearchPanel，FolderView 同时禁用移动选择/确认和添加原图。移动最大并发为 4，reject 与 resolved false 均计失败且不提前中止；重命名、时间、位置保持串行。顶层把任一 active batch mutation 纳入既有 transferring，复用 Tab、群组、beforeunload 与 PWA 更新闸门；横幅与 guard 文案必须显示具体操作、done/total、failed 和百分比。
2.60a 历史视频封面修复队列：PhotoCard 对内容有效的 thumbnail/preview 保持 0 个原视频修复请求；缺失派生图、派生图所有有限线路均失败，或 HTTP 200/naturalWidth=400 但像素近乎均匀纯白/浅灰时，只有进入 `IntersectionObserver(rootMargin: 600px 0px)` 的卡片才在 idle 调度后订阅全局按 blobName 去重的队列。低信息判定必须同时约束中性像素占比、亮度标准差、动态范围和接近空白的明暗区间，不得把正常明亮但有纹理/色彩的照片误判。同一 Blob 的所有实例共享 queued/repairing/succeeded 状态和新 URL。`saveData=true`、离线、slow-2g/2g 时自动并发为 0；未知网络并发 1，明确 3G/4G 最多 2；单视频估算上限 48 MiB、会话估算预算 160 MiB，不伪造实际下载字节。每 Blob 最多尝试 2 次，失败后至少退避 30 秒且仅重新进入视口才重试。执行器创建不进入布局的 muted/playsInline `HTMLVideoElement`，metadata 后在稍后时间点采样最多 3 个候选帧并选择信息量最高的一帧，复用共享 canvas WebP 提取和 `setVideoThumbnail` ETag 端点；主线路明确失败后最多切一次现有备用线路。离开视口、卸载、离线或 auth generation 变化必须 Abort 并 pause/remove src/load，清理 timer/listener。缺失、低信息、超预算、慢网和失败状态显示「打开视频后生成封面」，排队/生成显示 aria-live「正在生成封面」；MediaThumb、历史上的今天、故事和地图不得把无封面视频显示为白块或被动加载原视频。新上传本地截帧持久化期间必须占用同 blobName reservation，成功 URL 直接发布给队列而不重启原视频修复，并发 endpoint 写入复用同一 Promise。
2.61 Settings 历史维护任务守卫：`maintenanceTaskState.ts` 必须以 operationId、kind(thumbnails/metadata)、workspaceId、processed、changed、skipped、failed、hasMore、phase 建立纯状态边界，所有 progress/complete/stop/clear 仅在 token 匹配时生效。`backfillPhotoMetadata` 与 `backfillThumbnails` 保持旧调用兼容并接受可选 AbortSignal/onProgress，每个已验证页面立即上报累计值，abort 不得发下一页，缺失/重复 cursor、auth generation 漂移和 HTTP 错误继续显式失败。SettingsDialog 通过同步 ref gate + 单一 AbortController 禁止双击与跨类型重入，两按钮共享 disabled，aria-live/aria-busy 展示累计进度并提供停止按钮；停止、卸载或 workspace 漂移会 abort，保留完成页统计且 mounted/token guard 禁止迟到更新。运行中遮罩和关闭按钮不得卸载设置。AuthenticatedApp 通过 onMaintenanceStateChange 聚合 active 状态并纳入 Tab、GroupSwitcher、beforeunload、PWA 更新与 transfer banner 守卫；总数未知时只显示计数，不显示百分比。已登录 Header 继续禁止 `header-install-button` 与顶部安装文案。
2.62 回收站 mutation 守卫：新增纯逻辑 `trashMutationState.ts`，kind 固定覆盖 item-restore/item-delete/restore-all/empty-trash/restore-folder/delete-folder，状态携带 operationId/token、workspaceId、label、done、total、failed 与 running/stopping/stopped/completed phase；所有 progress/final 事件必须 token 匹配，旧任务迟到事件不得覆盖新任务。TrashView 的六类入口共用一个同步 ref gate 与可测试串行 runner，按点击时稳定快照逐项执行，普通失败计入 failed 后继续，Abort 不计失败且不得启动下一项；`restorePhoto`/`permanentlyDeletePhoto` 保持旧调用兼容并将可选 AbortSignal 传入 `fetchWithTimeout`。停止、真正卸载或 workspace 漂移必须 abort 当前请求并重新读取远端回收站，保留部分 done/failed 且不伪造已完成永久删除的回滚。顶部、文件夹、卡片和移动端固定恢复/删除按钮在 active 时均使用原生 disabled，进度状态通过独立 aria-live 区域展示。TrashView 通过 SettingsDialog 向 AuthenticatedApp 上报事件；Settings 关闭与维护任务互斥，顶层把 active trash mutation 纳入既有 Tab、GroupSwitcher、beforeunload 与 PWA 更新守卫，并优先展示准确 label、done/total、failed 和 percent。已登录 Header 的安装入口删除约束保持不变。
2.63 Settings 模态键盘与全局快捷键隔离：`.settings-dialog` 必须使用 `role="dialog" aria-modal="true"` 并由 `aria-labelledby` 引用可见标题。挂载时只保存一次原焦点并聚焦关闭按钮，卸载时仅向仍 `isConnected` 的原元素恢复；Tab/Shift+Tab 每次按键动态枚举当前可见、enabled 控件并首尾循环。Escape 必须调用既有 protected close，因此 active maintenance/trash 继续 toast 且不关闭；设置内所有普通键 stopPropagation，但不 preventDefault 输入或复制粘贴。模态焦点 helper 与 WhatsNewPopup 共用 `components/shared` 实现，且不得破坏 WhatsNew 独立 lazy chunk、idle mount、请求代次与 SW precache 排除。AuthenticatedApp 的纯 eligibility helper 必须拒绝 defaultPrevented、IME composing、重复 R/数字 Tab mutation、input/textarea/select/button/link/contenteditable/role=button 等交互目标及页面上的 `[aria-modal="true"]`，无模态 body 事件继续保留 R/?/1–6/S/Backspace/Delete/Escape 行为。不得修改 PhotoGallery/FolderView 查看器快捷键，也不得恢复已登录 Header 的安装入口、CSS 或顶部安装文案。
2.64 全局文件意图守卫：新增纯策略复用 `globalShortcutEligibility` 的交互目标 selector 与 `[aria-modal="true"]` 判定，并明确返回 accept、ignore-editor-or-modal、block-transfer（无文件另行忽略）。全局 paste 仅在 clipboard 提供有效图片、焦点不在 input/textarea/select/button/link/contenteditable/role=button、无模态层且最新完整 transferring 为 false 时 preventDefault 并调用一次根目录上传；编辑器/模态场景不 preventDefault、不 toast、不上传，activity 场景 preventDefault 并显示当时最新 guard，且不得提前显示成功 toast。全局 desktop drag 在 modal 或 upload/download/delete/voice/batch/trash/maintenance active 时不显示 overlay、不切 Tab，drop/dragover 仍 preventDefault；drop 只提示一次并清理 enter counter/overlay。正常无阻塞拖入继续只切 folder Tab 并提示选择文件夹，touch-primary 不注册，显式 UploadArea/file input 不增加额外限制。已登录 Header 继续禁止安装入口、CSS 与顶部安装文案。
2.65 已认证首屏媒体边界：selection-ready 必须绑定当前授权用户；持久化群组选择完成成员验证前，照片工作区不得读取个人列表缓存、渲染个人卡片或请求无 `groupId` 的 `/photos`，恢复后只允许请求该群组；明确 personal 可独立 resolve，群组 API 失败时仍可恢复。照片 effect 依赖稳定 resolved workspace ID，`groupsLoaded` 后续变化不得重启 personal 请求。同工作区成功刷新后 5 分钟内 focus/visibility/视图返回不得重复拉取和 JSON decode 全量列表，进行中的请求不得被 focus 重启。时间线、历史片段、故事、地图详情与文件夹网格仅使用授权 `thumbnailUrl`/`previewUrl`，旧缓存对象缺少 derivative 时显示本地占位，不得 fallback 到 `url`。打开 viewer 后可按 thumbnail→preview 策略显示，原图仅由显式原图预览、动图播放或下载触发；视频无封面继续显示本地占位且不得挂载原视频。行为 fixture 必须量化恢复刷新 personal request count=0、首次稳定渲染 personal card count=0、初始 grid original-media request count=0、同工作区 in-flight restart count=0；源码和构建产物同时保留策略契约。服务端 cursor pagination 仅能在照片缓存、MemoryMap 与统计消费方完整迁移后另行实施，不得半分页。已登录 Header 继续禁止 `header-install-button`、对应 CSS 与顶部安装文案。
2.66 文件夹重命名安全与离开保护：服务端 oldFolder/newFolder 必须是无空段、`.`、`..`、反斜杠和控制字符的规范相对路径，只允许同一 parent 下替换最后一段；NFC 后相同返回 `renamed=0`，但非等价改名必须保留 oldFolder 的原始 Unicode storage key。权限继续使用 personal owner/group membership；任何 mutation 前必须完整检查 oldPrefix 与 targetPrefix，源分页最多读取 101 条以判断 100 条上限，目标分页最多读取 1 条，源空返回 404，目标任意 Blob 返回 409「目标文件夹已存在」。所有原图、thumbnail/preview/voice/视频派生 Blob 按相对路径复制，整批只获取并复用一个受 request AbortSignal 约束的 delegation key；`beginCopyFromURL` 必须同时使用 destination `conditions.ifNoneMatch="*"` 与 preflight source ETag `sourceConditions.ifMatch`，且不覆盖 metadata/content headers；全部复制成功并复核 source/target inventory 前不得删除源。copy/delete/rollback 并发常量集中为 4/4/2；调度器必须记录 active peak，copy 首个失败后不再派发新 item，但等待已启动 item settle 后再以 2 路上限 best-effort rollback，禁止无上限 `Promise.all`。单次超过 100 个 Blob 必须在 mutation 前返回 413；copy phase 120 秒截止或 poll 失败时必须按 copyId 直接调用 Blob abort，不能依赖已进入 completed/error 状态后会 no-op 的 poller cancel；rollback 60 秒截止且每个 storage call 传 AbortSignal，服务端总请求 210 秒边界低于客户端 220 秒上限。429/503/ServerBusy 完全依赖 Azure SDK 的 Retry-After/指数退避，应用层不得自建 retry loop。复制失败只能在 copyId 与最新 ETag 均证明目标仍归属本 operation 时条件删除，copy initiation 响应不确定、所有权不明或 rollback 失败须记录并返回 recovery-needed。删除每个源前必须获取 60 秒目标租约并验证对应目标的 final copyId + ETag，整个 source delete 关键区必须受最长 20 秒 AbortSignal 约束，为租约保留 40 秒安全余量，再以 preflight source ETag 条件 `deleteIfExists`；目标/源已变化或删除失败时不得删对应目标，返回非 2xx、remainingSources，并保证每项至少一份；完成后再次核对 inventory，不得把并发变化伪报成功。客户端 rename API 保持旧调用兼容，增加可选 AbortSignal 与 220 秒 HTTP 上限；FolderView 在请求前拒绝 `/`、`.`/`..`、反斜杠/控制字符和同级冲突，同时保留 oldFolder 原始 key。顶层 folder rename state 携带 operationId/workspaceId/old/new label/phase，同步 ref gate 防双击，stale finally 不清新任务；active 时根层/递归 FolderCard、文件夹创建/删除、批量、上传和移动入口真实 disabled，并纳入 Tab、GroupSwitcher、beforeunload、全局文件意图和 PWA update `transferring`。根目录和递归 FolderCard 必须用独立原生按钮承载进入动作，提供含文件夹名与照片数量的稳定 aria-label，原生支持 Enter/Space 与 disabled；重命名输入、重命名/删除按钮不得嵌套在进入按钮内，必须保持事件隔离和可见 focus。workspace 漂移必须 AbortSignal 停止客户端等待；成功、失败、timeout 或 partial server error 均通过当前 workspace 的最新 `fetchPhotos` callback 对账，不得把旧空间 closure 的结果应用新空间；单次请求协议没有可信 server progress 时，banner 只显示「正在重命名文件夹 A → B」及本地 phase，不得伪造百分比或计数。不得恢复已登录 Header 安装入口/CSS/顶部文案或移动 Header。
2.67 移动端布局与 PWA meta 契约：320px/390px 下 `.weekly-summary-card` 必须通过与 `.view-tabs-shell-wrap` 同源的 inline padding 变量保持 viewport full-bleed，根文档 `scrollWidth === clientWidth` 且不得用 html/body 全局 `overflow-x:hidden|clip` 掩盖；`.view-tabs` 继续 `overflow-x:auto` 独立横向滑动，本周标题不得被压缩裁切。≤360px 的 `WorkspaceFab` 默认只显示至少 48px、含 safe-area 的单入口，展开后保留筛选/片段侧栏及两个快捷动作；按钮暴露稳定 `aria-expanded`/`aria-controls`，展开聚焦首动作，Escape 收起并把焦点还给入口，桌面布局不变。源码与 dist 都必须同时包含 `mobile-web-app-capable=yes` 和 Apple meta；production smoke 校验线上 HTML。不得恢复 `.header-install-button`、对应 CSS 或顶部安装文案，也不得移动 Header 掩盖布局。
2.68 上传吞吐与背压：新增纯函数网络策略和加权队列，图片权重 1，视频或超过 20 MiB 的大文件权重 2；4G 预算 3（最多 3 图或 1 视频 + 1 图），未知/3G 预算 2（不能退回全部小图串行），`saveData`/slow-2g/2g 预算 1，超预算重项允许独占防饥饿。进度必须为 succeeded/failed 文件完整字节 + preparing/uploading 项 loaded 字节，状态覆盖 pending/preparing/uploading/succeeded/failed/cancelled；暂停只阻止新 dispatch，不 abort 已开始 XHR。批次捕获 auth generation、workspace、显示名和 groupId，空间/认证漂移共用 AbortSignal；每文件 uploadId 在 retry loop 外生成。XHR 错误携带 kind/status/retryAfterMs；仅 network/timeout/408/425/429/5xx 最多三次，Retry-After 支持秒和 HTTP date，并使用 1 秒基数、30 秒 jitter cap、60 秒总 cap 的 exponential full jitter，AbortSignal 可中断离线与 delay 等待；401/403/404/409/413/422 不重试。视频本地封面提取/持久化必须留在 weight-2 worker 生命周期内，不能与下一视频重新放大内存。服务端 MIME 通过后、`arrayBuffer()` 前解析 Content-Length，声明超限立即 413，缺失 411、非法 400；读取后继续验证真实长度不超限且与声明一致。单 Function 实例准入总权重 3/256 MiB、单用户权重 3/220 MiB，lease 覆盖 Blob 写入和图片派生生成并 finally 幂等释放，活跃用户归零删除、表上限 1024；拒绝 429 + 可跨域读取的 Retry-After: 3。必须明确这是单实例保护，不伪装分布式限流；无全站实测证据时不得给 host.json 添加会影响轻请求的 HTTP concurrency。下载保持附件 SAS → 浏览器直连 Blob；不得恢复 `.header-install-button`、CSS 或顶部安装文案。

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

- AZURE_STATIC_WEB_APPS_API_TOKEN
- VITE_API_BASE（例如 https://<function-app>.azurewebsites.net/api）

## 6.2 工作流行为

- deploy-backend.yml
1. 仅 server 相关变更触发
2. 安装依赖、构建、Azure 登录
3. 打包并 zip 部署到 Function App

- deploy-frontend.yml
1. 仅 client 相关变更触发
2. 注入 VITE_API_BASE 构建
3. 发布到 Static Web Apps

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
