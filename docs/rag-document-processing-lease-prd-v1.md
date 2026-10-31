# 文档处理租约与长文档续处理 PRD V1

## 1. 目标

为每一份原始内容相同的文件建立基于内容指纹的独占处理能力，确保同一份文件在 Chunk Lab 中同一时间只有一个人可以处理；同时支持长文件跨天保存、释放锁后继续处理。

本 PRD 只解决 Chunk Lab 的文档处理并发与续处理，不引入业务批次模型，不改变解析缓存、对象存储生命周期或下游 RAG 入库协议。

## 2. 已确认的业务规则

- 内容相同以原始上传文件字节的 SHA-256 `contentSha256` 判定。
- 同一 `contentSha256` 复用一份 `Document`、一份 Parsed Document 和一份 Chunk Draft。
- 处理锁的范围是进入并修改该文件的 Chunk Lab 工作区，包括生成预览、进入修订、编辑 Chunk、保存 Draft 和导出。
- 上传/收到消息时不自动占用人工处理锁；用户真正打开该文件工作区时获取租约。
- 解析未完成时也占用该文件的处理租约，其他用户不能进入同一份可处理工作区。
- 锁失败的用户不能进入编辑工作区，只能看到只读的占用状态和刷新入口。
- Redis 中保存的是临时租约，不保存 Draft 或处理进度。
- Draft、版本号和处理进度持久化在服务端存储中。
- 会话关闭时主动释放租约；异常退出依靠 TTL 到期释放。
- 允许同一文件由不同有权限用户在不同时间继续处理，不允许普通用户强制接管正在使用的租约。
- 使用现有 Control Center 登录身份识别用户；租约同时绑定 `userId` 与 `sessionId`。
- 同一用户的第二个标签页不能获得同一文件的第二把编辑租约，建议进入只读状态。

## 3. 文件接入模型

测试阶段和生产阶段只在“如何取得原始字节”上不同，取得原始文件后走同一条内部流程。

### 3.1 测试阶段

工作台通过上传接口提交文件。服务端接收后保存到 MinIO，读取实际文件字节并计算 `contentSha256`，再注册或复用 `Document`。

### 3.2 生产阶段

数据中台发送消息，消息至少包含事件 ID 和 MinIO 对象定位；服务端从 MinIO 读取原始文件，计算实际 SHA-256，并在消息提供 `expectedSha256` 时进行校验。事件 ID 用于消费幂等，内容指纹用于内容去重和处理互斥，二者不可混用。

### 3.3 统一内部模型

```ts
type MaterializedDocument = {
  contentSha256: string;
  fileName?: string;
  size: number;
  storageRef: string;
};
```

文件名、上传 ID、消息事件 ID、MinIO key 都不是锁的依据。

## 4. 文档与处理状态

当前阶段不设计 `batchId`。同一指纹对应一份文档和一份处理状态；未来业务来源、任务或商品等上下文通过关联关系扩展，不复制 Document/Draft。

```ts
type Document = {
  id: string;
  contentSha256: string; // unique
  fileName?: string;
  sourceRef: string;
  parseState: "pending" | "processing" | "ready" | "failed";
  reviewRevision: number;
  reviewProgress: ReviewProgress;
};

type ReviewProgress = {
  lastEditedChunkId: string | null;
  lastEditedSourceBlockId: string | null;
  lastViewedPage: number | null;
  completedChunkIds: string[];
  updatedAt: string;
};
```

Chunk 处理状态：

```text
pending -> in_progress -> completed
completed -> needs_revision -> in_progress -> completed
```

保存 Draft 不等于完成。完成状态通过批量操作维护：标记当前 Chunk、标记选中范围、标记当前页范围、标记到这里；支持撤销完成状态。已完成 Chunk 被重新编辑时，从 `completedChunkIds` 移除并变为 `needs_revision` 或 `in_progress`。

## 5. 长文件续处理

第一天的租约释放后，Draft、`reviewRevision` 和 `ReviewProgress` 保留。第二天打开时：

1. 通过 `contentSha256` 找到原 Document。
2. 读取最新 Draft、版本和 ReviewProgress。
3. 获取一把新的 Redis 租约，不继承旧 `leaseId`。
4. 默认恢复上次光标；没有光标时定位第一个未完成 Chunk。
5. 从持久化状态继续处理，不重新解析、不丢弃已有修改。

前端提供“标记到这里”，顶部显示 `已处理 N / M`，Chunk 左侧显示处理状态图标。

## 6. Redis 租约契约

推荐 key：

```text
rag:document-lease:{contentSha256}
```

value 至少包含：

```json
{
  "leaseId": "random-opaque-id",
  "userId": "control-center-user-id",
  "sessionId": "browser-session-id",
  "acquiredAt": "ISO-8601",
  "lastHeartbeatAt": "ISO-8601"
}
```

获取使用原子 `SET key value NX EX <ttl>`。续租和释放必须校验 `leaseId`；释放使用 Lua 原子校验删除，禁止无条件 `DEL`。第一版建议 TTL 45～60 秒，心跳间隔 10～15 秒。

服务端所有写操作都必须同时校验：

1. 当前请求的 `leaseId` 仍是 Redis 持有者。
2. 请求携带的 `expectedRevision` 等于服务端当前 `reviewRevision`。

租约失效返回 `423 Locked`；版本冲突返回 `409 Conflict`，前端切换只读并重新加载最新 Draft。

## 7. 访问与用户体验

- 首次进入工作区先尝试获取租约，成功后进入可编辑状态。
- 已被占用时阻止进入编辑工作区，显示脱敏持有者、开始时间、最后心跳时间和预计超时时间。
- 提供主动“退出处理/释放锁”按钮。
- 页面关闭时尝试主动释放，但不依赖关闭事件作为唯一保障。
- 心跳停止后，TTL 到期，其他用户可重新获取租约。
- 同一用户的第二标签页显示只读，不允许覆盖第一标签页。
- 不允许普通用户强制接管；管理员接管如有需要另行设计。

## 8. 导出规则

导出是下游交付快照，不是续处理机制，也不释放 Redis 租约。

第一版**仅允许全部 Chunk 为 `completed` 后导出**。存在 `pending`、`in_progress` 或 `needs_revision` 时，导出接口拒绝请求并返回未完成数量。

导出快照至少记录：

```ts
{
  documentId,
  contentSha256,
  reviewRevision,
  exportedAt,
  completedChunkIds,
  chunks
}
```

导出不冻结 Draft；后续修改需要重新导出。

## 9. 非目标

- 不实现 Redlock 多节点算法。
- 不引入业务批次、任务转交或管理员强制接管。
- 不把 Redis 作为 Draft 或 ReviewProgress 的持久化存储。
- 不在本 PRD 中实现数据中台消息协议的完整字段治理。
- 不改变 MinerU 解析质量、切分算法或 RAG 检索策略。

## 10. 验收标准

- 两个会话同时打开相同原始字节文件时，仅一个会话进入编辑态。
- 未持有租约的会话不能生成、修改、保存或导出该文档。
- 租约持有者心跳可续租；释放后其他会话可获取。
- 浏览器异常退出后，TTL 到期后锁自动释放。
- 第一天保存部分 Draft，第二天可恢复最新 Draft 和进度继续处理。
- 批量“标记到这里”正确更新 `completedChunkIds`，重新编辑会撤销完成状态。
- 未全部完成时导出被拒绝；全部完成后导出快照包含版本和指纹。
- 同内容重复上传或重复消息复用同一 Document，不重复创建处理状态。
- 保存请求的租约校验和版本校验能阻止旧页面覆盖新 Draft。

## 11. 开发门槛

本 PRD 只作为设计基线。实现前需要单独明确“开始开发文档处理租约 V1”。
