# 更新日志

### v1.9.0 — Algorithm Package · 流量优化深化 · 下载体验重构

**新功能**
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
