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
- 数据：Azure Cosmos DB NoSQL（users/admins/groups/invites）
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
2. 时间线与文件夹视图
3. 文件夹（含子文件夹）浏览与面包屑
4. 照片重命名、移动、下载
5. 桌面拖拽移动 + 移动端按钮移动
6. 批量操作：删除、移动、重命名
7. 收藏（星标）与“仅收藏”筛选
8. 搜索与筛选（名称、主题、上传者、日期）

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
3. 复制链接到剪贴板
4. 权限校验：个人空间仅本人可生成，群组仅成员可生成

---

## 4. 代码结构要求

目标结构（关键）：

- client
- server
- .github/workflows/deploy-frontend.yml
- .github/workflows/deploy-backend.yml
- README.md

后端函数入口应注册照片、回收站、认证、群组、邀请相关函数。

---

## 5. Azure 资源与配置

## 5.1 资源清单

必须创建：

1. Resource Group
2. Function App（Linux，Node 24）
3. Static Web Apps
4. Storage Account + Blob Container（如 photos）
5. Cosmos DB NoSQL + Database + 容器：users/admins/groups/invites
6. （可选）Azure Communication Services（邮件邀请）

## 5.2 RBAC

Function App 的系统分配托管身份需要：

- Storage:
1. Storage Blob Data Contributor
2. Storage Blob Delegator

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
10. 邀请链接接受后可入组并切换群组
11. 前后端 CI/CD 均可通过并部署成功

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
