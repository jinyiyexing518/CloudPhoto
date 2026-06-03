# CloudPhoto

私有化云相册，支持用户认证、JWT 自动刷新、群组共享、文件夹管理，以及全程无密钥的 Azure 托管身份鉴权。

用户手册：[USER_GUIDE.md](USER_GUIDE.md)

**前端：** React 18 + Vite 5 → 部署到 **Azure Static Web Apps**
**后端：** Azure Functions v4（Node.js 24、TypeScript）→ 部署到 **Azure Functions**（`cloudphoto-api`）
**存储：** Azure Blob Storage（`photostorage` / `photos`）— 通过**用户委托 SAS**（无账户密钥）访问
**数据库：** Azure Cosmos DB NoSQL（`cloudphoto`）— 通过**托管身份**（无连接字符串密钥）访问

---

## 更新日志

### v1.7.1 — 重要片段 Top 20 限制

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

---

## 架构

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

本地开发时，Vite 将所有 `/api/*` 请求代理到 `localhost:7071`，开发与生产无需修改 URL——前端在构建时读取 `VITE_API_BASE`（默认为 `/api`）。

---

## 功能列表

- **JWT 认证与自动刷新** — 2 小时访问令牌 + 30 天滚动刷新令牌；收到 401 时客户端静默刷新并重试原请求；并发 401 共享同一个刷新请求（互斥锁）
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
- **批量操作** — 多选模式支持批量删除、批量移动、批量设置拍摄时间、批量修改 GPS 位置
- **多照片上传** — 同时选择多张照片；按文件夹顺序上传并显示进度（`⏳ 2/5`）；部分失败提示；客户端 MIME 类型与 20 MB 大小校验
- **照片下载** — 直接从浏览器下载原始文件（移动端与桌面端均支持）
- **过期分享链接** — 生成单张照片的公开可读链接，TTL 可选（1小时 / 24小时 / 3天 / 7天）
- **一键分享复制** — 优先使用 Clipboard API，自动兜底到传统复制，最后降级为手动复制提示
- **托管分享链接（云端）** — 设置页可提前吊销链接或延长有效期，维护每条链接的状态与生命周期
- **文件夹分享对话框** — 分享当前文件夹时弹出专用对话框并明确选择时长，工具栏保持紧凑
- **托管分享筛选** — 云端分享链接支持按状态（有效/已过期/已吊销）和文件名模糊搜索
- **灵活延长分享** — 托管链接可按预设时长延长（1小时 / 24小时 / 3天 / 7天 / 30天）
- **分享统计** — 每条托管分享链接记录创建时间、浏览次数和最近访问时间
- **自动过期对齐** — 列出托管链接时，后端自动将时间已过期的有效链接标准化为「已过期」
- **乐观并发安全** — 元数据更新/移动/删除/恢复/分享维护均使用条件写入（ETag + 重试）防止并发覆盖
- **统一冲突 UX** — 后端返回 `409` 时，前端显示统一 toast（`资源已被他人修改，请刷新后重试`）
- **本地分享链接管理器** — 设置 → 📱 应用 展示近期有效分享链接，支持一键复制/打开/删除和批量清除
- **照片重命名** — 不重新上传即可更改任意照片的显示名称
- **移动照片** — 通过 UI 或拖拽在文件夹间移动照片
- **时间线视图** — 按日期分组的照片时间线，默认最新在前
- **📷/☁ 排序方式切换** — 可在「拍摄时间」与「上传时间」两种排序之间切换；无拍摄时间时自动回退到上传时间
- **历史照片元数据回填** — 一键扫描所有缺少拍摄时间或 GPS 的旧照片，从 EXIF 自动补全并写回
- **以照片为主的聚焦工具栏** — 首页顶部工具栏轻量展示当前空间、数量、运行模式及高价值导航入口
- **全高局部宽侧边栏** — 时间线和重要片段使用占横向 80%–90% 的右侧全高面板，其余区域变暗，视觉上明确是「侧面弹出工具面板」
- **快速日期筛选 chip** — 「今日 / 本周 / 本月 / ⭐ 收藏」一键 chip 行，无需打开侧边栏即可即时按日期范围筛选；激活时高亮并出现「✕ 清空」
- **激活筛选指示点** — 任意筛选激活时时间线页签标签上出现橙色小点
- **空相册首次引导** — 空间无照片时显示「还没有照片」友好提示和直达上传入口
- **传输进度横幅** — 上传时顶部固定横幅显示当前文件名、`n/total` 计数器、进度条和百分比；下载时显示「下载中，请勿关闭页面」
- **返回顶部按钮** — 滚动 500px 后出现悬浮圆形按钮，一键平滑回顶；侧边栏锁定滚动时隐藏
- **窗口聚焦自动刷新** — 切回应用时静默重新获取照片列表（每 60 秒最多一次），多设备编辑无需手动刷新
- **键盘快捷键** — R=刷新；1/2/3=切换 Tab；S=切换侧边栏；Backspace/Delete=清空筛选；?=快捷键速查表；Esc=关闭任意浮层；均跳过输入框焦点
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
- **重要片段本地兜底** — 后端 moments 暂时不可用时，客户端跨刷新本地保存浏览计数，并将会话标记为「仅本地」直到服务端同步恢复
- **重要片段诊断页** — 设置中专用诊断 Tab，显示前端版本/构建时间、Service Worker 数量、本地 moments 缓存大小及持久化状态
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
- **Toast 通知系统** — 轻量 React-Context toast 队列（success/error/info）；3.5 秒后自动消失
- **图片加载骨架屏** — 每张缩略图加载时显示闪光骨架，加载完成后淡入，消除布局偏移
- **激活筛选 chip** — 已应用的主题/上传者/日期筛选以可关闭 chip 形式显示在搜索栏下方
- **名称搜索防抖** — 名称筛选 300ms 防抖，防止输入时不必要的重新渲染
- **全选 / 取消全选** — 批量模式下时间线和文件夹视图均支持一键全选切换
- **批量删除确认对话框** — 批量删除前需明确确认
- **并行批量移动** — 文件夹批量移动使用 `Promise.all` 并发发起所有移动请求
- **加载 spinner** — 照片获取期间动态 CSS spinner 替代静态「加载中...」文字
- **重试按钮** — 加载失败状态显示「重试」按钮，无需刷新页面即可重新获取
- **丰富空状态** — 照片图标 + 中文提示替代纯文字占位符
- **删除二次确认** — 自定义确认对话框（不使用浏览器 `alert`）
- **移动端响应式** — ≤680px 时 2 列网格、紧凑 header、触摸友好弹窗；文件夹 Tab 移动端适配两列
- **管理员工具** — 超级管理员（通过 `SUPER_ADMIN_USERNAME` 环境变量配置）可将其他用户提升为 admin
- **PWA 应用模式** — 可安装为桌面/移动应用（manifest + Service Worker + 更新提示）
- **浏览器优先更新模式** — 普通浏览器会话注销旧 Service Worker 优先即时更新；仅已安装的独立模式保留持久化 SW 缓存语义
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
- **传输安全守卫** — 上传/下载进行中时阻止 Tab 切换，浏览器刷新/关闭显示 unload 确认
- **无密钥安全** — 存储和数据库均无账户密钥；使用 `DefaultAzureCredential`（Azure 上托管身份，本地 Azure CLI）
- **CI/CD** — GitHub Actions + OIDC 认证（无存储密码）；前后端分离 workflow，仅在相关路径变更时触发
- **自动隐藏 header** — 向下滚动时顶部导航栏滑出，向上滚动或回顶时立即重现；300ms cubic-bezier 平滑动画，移动端最大化照片画布
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
```

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
| `POST`   | `/api/photos/upload?filename=<name>[&folder=<path>][&groupId=<id>][&gpsLat=<lat>][&gpsLon=<lon>]` | ✓ | 上传（原始二进制 body）；拒绝非图片/视频 MIME（415）和超大文件（413） |
| `GET`    | `/api/photos/download?name=<blobName>` | ✓ | 代理下载，附 `Content-Disposition: attachment` |
| `GET`    | `/api/photos/share?name=<blobName>&hours=<1..168>` | ✓ | 创建过期分享链接（`{ url, expiresAt }`） |
| `GET`    | `/api/photos/share/open/{linkId}` | — | 打开托管公开分享链接（重定向到短效 SAS 并增加浏览统计） |
| `GET`    | `/api/photos/share/links[?status=active|expired|revoked&q=<keyword>]` | ✓ | 列出当前用户的托管分享链接，支持状态/名称筛选 |
| `PATCH`  | `/api/photos/share/links/{linkId}` | ✓ | 立即吊销（`action=revoke`）或延长有效期（`action=extend`, `hours=1..720`）；冲突返回 `409` |
| `POST`   | `/api/photos/moments/insights` | ✓ | 批量查询指定照片的 moments 统计，通过 JSON body `{ photoNames: string[] }`（跨设备持久化） |
| `POST`   | `/api/photos/moments/view` | ✓ | 记录一次 moments 浏览（`photoName`, 可选 `viewerName`），乐观并发 |
| `POST`   | `/api/photos/move` | ✓ | 将照片移动到其他文件夹 |
| `PATCH`  | `/api/photos/metadata?name=<blobName>` | ✓ | 更新主题/文件夹/原始名称/拍摄时间/GPS；冲突返回 `409` |
| `DELETE` | `/api/photos?name=<blobName>` | ✓ | 软删除照片；冲突返回 `409` |
| `POST`   | `/api/photos/backfill[?groupId=<id>]` | ✓ | 扫描缺少 `takenAt` 或 `gpsLat` 的 blob，从 EXIF 回填元数据；返回 `{ processed, updated, failed }` |

**`GET /api/photos` 所有权规则：**
- `?groupId=<id>` — 请求者必须是该群组成员
- 无 `groupId` — 返回请求者的私有照片（管理员可看全部私有照片）

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
3. 原请求使用新令牌**自动重试一次**，对调用方完全透明
4. 若刷新令牌本身已过期，用户跳转到登录页
5. 刷新令牌在每次使用时**滚动**（30 天窗口向前推移）

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

push 到 `main` 时自动运行三个 workflow：

| Workflow | 文件 | 触发条件 |
|----------|------|----------|
| 部署后端 | `.github/workflows/deploy-backend.yml` | `packages/server/**` 变更 |
| 部署前端 | `.github/workflows/deploy-frontend.yml` | `packages/client/**` 或 `changes/**` 变更 |
| 同步更新日志 | `.github/workflows/sync-changelog.yml` | `changes/**` 变更 |

所有 workflow 均使用 **OIDC 认证**（无存储的 Azure 密码/密钥）。

### 所需 GitHub Secrets

| Secret | 值 |
|--------|-----|
| `AZURE_CLIENT_ID` | 服务主体应用程序 ID |
| `AZURE_TENANT_ID` | Azure 租户 ID |
| `AZURE_SUBSCRIPTION_ID` | Azure 订阅 ID |
| `AZURE_FUNCTIONAPP_NAME` | `cloudphoto-api` |
| `AZURE_RESOURCE_GROUP` | `CloudPhoto` |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | SWA 部署令牌 |
| `VITE_API_BASE` | `https://cloudphoto-api.azurewebsites.net/api` |

### 更新日志自动化

- **Cosmos DB（线上 WhatsNew 数据）：** `sync-changelog.yml` 在 `changes/**` 有 push 时自动触发，无需手动操作
- **`changelog.json`（静态兜底）：** 部署前端时 CI 自动运行 `node scripts/collect-changes.mjs` 重新生成，打包进静态资源
- **新增 change 文件：** 在 `changes/` 目录创建 `YYYY-MM-DD-id.json`，commit + push，其余全部自动完成

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
