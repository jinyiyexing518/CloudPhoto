# @cloudphoto/algorithm

共享优化算法库，供 `cloudphoto-client`（前端）直接引用。

---

## 模块

| 文件 | 内容 |
|------|------|
| `media.ts` | 缩略图 MIME 类型、尺寸 / 质量常量、BLANK_GIF 占位符 |
| `bandwidth.ts` | HTTP Range Request 策略（视频封面 512 KB 截帧）、预加载边距 |
| `priority.ts` | 照片重要性评分函数（收藏 / 标签 / 时效性权重）|
| `pagination.ts` | 默认分页大小（24）、无限滚动 sentinel 边距 |
| `render.ts` | 查看器图片分级阈值（thumbnail / preview / original 选择逻辑）|

---

## 设计原则

- **纯函数 + 常量**：无副作用，无 React / Azure 依赖
- **可测试**：所有算法函数接受普通对象，输出纯数值或字符串
- **跨平台**：逻辑与平台无关；客户端通过 Vite alias 引入，服务端暂保留本地镜像常量

---

## 使用方式

### 前端（React / Vite）

```typescript
import { scorePhotoImportance, DEFAULT_PAGE_SIZE } from "@cloudphoto/algorithm";
```

通过 `packages/client/vite.config.ts` 的 `resolve.alias` 映射到源码，Vite 直接 tree-shake 和打包。

---

## 添加新算法

1. 在 `src/` 下创建新文件（e.g. `compression.ts`）
2. 在 `src/index.ts` 中 `export * from "./compression"`
3. 写文档注释说明算法背景与参数选择依据
