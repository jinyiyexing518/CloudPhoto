# AI_REPRO_SPEC

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
3. 文件夹（含子文件夹）浏览与面包屑
4. 照片重命名、移动、下载
5. 桌面拖拽移动 + 移动端按钮移动
6. 批量操作：删除、移动、重命名
7. 收藏（星标）与“仅收藏”筛选
8. 搜索与筛选（名称、主题、上传者、日期）
9. 文件夹视图需接入浏览器/系统返回栈：返回键优先回退到上一级文件夹
9. 文件夹导航需接入浏览器/系统返回栈：返回键优先回退到上一级文件夹

### 3.3 回收站

1. 删除为软删除（metadata 写 deletedAt/deletedBy）
2. 回收站列表、恢复、彻底删除
3. 支持“全部恢复”和“清空回收站”
4. 恢复后相册自动刷新
5. 恢复后显示上传日期（createdAt），不是恢复时间

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

### 3.8 传输稳定性

1. 上传/下载进行中阻止应用内页面切换
2. 上传/下载进行中刷新或关闭页面触发浏览器离开确认
3. 下载与上传默认保持原图，不做压缩

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
