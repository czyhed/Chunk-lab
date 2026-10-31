# SPU 商品资料 PostgreSQL 数据库交接文档

## 1. 文档目的

本文说明 SPU 商品资料进入 PostgreSQL/pgvector 后的表结构、SPU 归属字段、版本切换和查询规则。

MinIO 中的原始文件、MinerU 结果、SPU Markdown、Manifest 和 `current.json` 规则，见：

- `docs/spu-document-handoff-design.md`
- `docs/spu-product-material-export-prd-v1.md`

本文只说明 PostgreSQL 持久化边界，不包含数据库地址、账号、密码、连接字符串或生产数据。

## 2. 先说结论

### 2.1 PostgreSQL 没有单独的 SPU 主数据表

当前 SPU 主记录和类目目录由应用工作区的 `spu-catalog.json` 持久化，不是 PostgreSQL 表。

因此：

- 不要在 PostgreSQL 中重复创建 SPU 主记录；
- 不要把 `rag.vector_records_v2_d<dimensions>` 当作 SPU 主数据表；
- 向量表中的 SPU 字段只表示文档/Chunk 的归属和检索目标；
- SPU Markdown 的正式文件和当前版本指针仍以 MinIO 为准。

### 2.2 PostgreSQL 保存什么

PostgreSQL 保存：

- 文档父记录和删除状态；
- Chunk 的 SPU 归属、资料类型、来源版本和审核/Embedding 版本；
- Chunk 向量及其溯源元数据；
- 向量快照和每个目标 SPU 的当前快照指针；
- MinIO 对象的稳定引用和校验信息；
- 解析缓存、维度契约、删除审计。

PostgreSQL 不保存原始文件、Markdown 全文文件、MinerU ZIP、图片二进制、base64、过期签名 URL 或凭证。

## 3. Schema 与维度表名

当前数据库契约为 schema `2.0`。Embedding 维度写入表名，例如维度为 `1024` 时：

```text
rag.vector_records_v2_d1024
```

表名中的 `<dimensions>` 必须与 `vector_dimensions.dimensions` 和 `vector_dimensions` 列类型一致，不能把不同维度的向量混写到同一张表。

## 4. 表总览

| 表 | 用途 | SPU 关系 |
| --- | --- | --- |
| `rag.schema_migrations` | 迁移版本账本 | 记录 schema 版本，不保存 SPU 数据 |
| `rag.documents` | 文档父表 | 向量记录的文档级外键 |
| `rag.vector_records_v2_d<dimensions>` | Chunk 向量和归属 | 保存 `target_spu_id`、`spu_id`、`target_spu_ids`、`scope` 等 |
| `rag.vector_snapshots` | 向量快照 | 保存一次文档向量提交的完整 JSON 快照 |
| `rag.vector_currents` | 当前版本指针 | 每个目标 SPU 指向当前快照 |
| `rag.vector_dimensions` | Embedding 维度契约 | 按向量目标限制模型/维度组合 |
| `rag.object_references` | MinIO 对象引用 | 保存稳定 URI、对象键和校验值 |
| `rag.parse_cache` | MinerU 解析缓存 | 按文件内容和解析配置复用解析任务 |
| `rag.deletion_audit` | 删除审计 | 记录向量软删除和物理删除 |

## 5. 文档父表：`rag.documents`

该表是向量记录的文档父表，不是完整的 Source Document 资料库。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `target_id` | `text` | 向量数据库目标/配置标识 |
| `document_id` | `text` | Parsed Document 或业务文档 ID |
| `source_document_version` | `text`，可空 | 来源文档版本 |
| `deleted_at` | `timestamptz`，可空 | 文档软删除时间 |
| `delete_after` | `timestamptz`，可空 | 允许物理清理的时间 |

主键：

```text
(target_id, document_id)
```

一个文档可以在 Chunk 向量表中对应多个 `target_spu_id`。

## 6. SPU Chunk 向量表：`rag.vector_records_v2_d<dimensions>`

维度为 `1024` 时，实际表名为 `rag.vector_records_v2_d1024`。

### 6.1 主键与目标关系

主键：

```text
(target_id, document_id, target_spu_id, chunk_id)
```

其中 `target_spu_id` 是向量记录实际服务的目标 SPU。多 SPU 文档会为不同目标 SPU 产生独立记录，避免不同 SPU 的检索范围混在一起。

### 6.2 SPU 与版本字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `target_spu_id` | `text`，非空 | 当前这条向量记录服务的目标 SPU；参与主键 |
| `spu_id` | `text`，可空 | 记录来源/文档级 SPU 标识 |
| `target_spu_ids` | `jsonb`，可空 | 文档声明绑定的 SPU ID 列表 |
| `scope` | `text`，可空 | Chunk 归属范围，例如 `assigned`、`common`；最终取值由应用契约校验 |
| `source_document_version` | `text`，可空 | 生成该记录所依据的来源文档版本 |
| `document_type` | `text`，可空 | 资料类型，例如 `manual`、`specification` |
| `chunk_revision` | `text`，可空 | Chunk/审核版本 |
| `embedding_revision` | `text`，可空 | Embedding 版本 |
| `vector_snapshot_id` | `text`，可空 | 所属向量快照 ID |

### 6.3 Chunk 与向量字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `chunk_id` | `text` | Chunk 稳定 ID |
| `schema_version` | `text` | 当前必须为 `2.0` |
| `chunk_type` | `text` | `text`、`image`、`table` 等 Chunk 类型 |
| `content_payload` | `jsonb` | Chunk 结构化内容 |
| `final_text` | `text` | 审核后的最终文本 |
| `embedding_text_hash` | `text` | 实际送入 Embedding 的文本哈希 |
| `embedding_profile_id` | `text` | Embedding 配置 ID |
| `embedding_model` | `text` | 实际模型标识 |
| `vector_dimensions` | `integer` | 必须与表名维度一致 |
| `embedding` | `vector(dimensions)` | 向量本体，不应通过公开 API 返回 |
| `source_segments` | `jsonb` | 页码、bbox、来源 Block 等溯源信息 |
| `strategy_version` | `text` | Chunking 策略版本 |
| `context_version` | `jsonb` | Context 生成/确认版本信息 |
| `content_hash` | `text` | Chunk 内容哈希，用于幂等判断 |
| `updated_at` | `timestamptz` | 最近更新时间 |
| `deleted_at` | `timestamptz`，可空 | 软删除时间 |
| `delete_after` | `timestamptz`，可空 | 允许物理清理的时间 |

图片 Chunk 的 `image_object_uri` 通过外键引用 `rag.object_references(uri)`；图片本体仍在 MinIO。

## 7. 向量快照：`rag.vector_snapshots`

该表保存一次文档向量提交的快照，用于版本化和失败恢复。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `snapshot_id` | `text`，主键 | 快照 ID |
| `target_id` | `text` | 向量目标 |
| `document_id` | `text` | 文档 ID |
| `records` | `jsonb` | 本次提交的向量记录快照 |
| `created_at` | `timestamptz` | 快照创建时间 |

快照写入采用幂等语义：相同 `snapshot_id` 不重复创建。

## 8. 当前快照指针：`rag.vector_currents`

该表表示每个目标 SPU 当前生效的向量版本。

主键：

```text
(target_id, document_id, spu_id)
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `target_id` | `text` | 向量目标 |
| `document_id` | `text` | 文档 ID |
| `spu_id` | `text` | 目标 SPU ID |
| `source_document_version` | `text` | 当前指针对应的来源版本 |
| `document_type` | `text`，可空 | 当前资料类型 |
| `embedding_model` | `text` | 当前 Embedding 模型 |
| `embedding_revision` | `text` | 当前 Embedding 版本 |
| `snapshot_id` | `text` | 引用 `rag.vector_snapshots(snapshot_id)` |
| `activated_at` | `timestamptz` | 当前指针生效时间 |

同一 `(target_id, document_id, spu_id)` 只能有一个当前指针。重新解析、重新审核或重新 Embedding 后，应先生成新快照，再原子更新该目标 SPU 的指针。

## 9. SPU 继承与例外 Chunk 的数据库表达

应用层先确定文档级目标 SPU，再把 Chunk 展开为目标 SPU 记录：

| 业务情况 | 数据库表达 |
| --- | --- |
| 单 SPU 文档普通 Chunk | `target_spu_id` 为文档 SPU，`scope` 通常为 `assigned` 或应用映射值 |
| 多 SPU 文档的指定 Chunk | 只为被指定的 `target_spu_id` 写入记录，`scope=assigned` |
| 公共资料 Chunk | 可为多个目标 SPU 写入记录，`scope=common`，`target_spu_ids` 保留声明范围 |
| 未分配或冲突 Chunk | 不应作为正式 SPU 向量提交；由应用层阻断或标记失败 |
| Chunk 单独覆盖 | 只更新该 Chunk 对应的 SPU 记录，不改变文档级 SPU 绑定 |

数据库表不负责推断“普通 Chunk 是否继承文档 SPU”。继承结果必须在服务端生成向量记录时显式落到 `target_spu_id`，查询时不应依赖前端状态或临时 `pendingSpuIds`。

## 10. 版本、重新解析与失效规则

1. 上传或解析完成不会自动写入向量表。
2. 只有完成 Chunk 审核、Embedding 并显式执行数据库写入任务后，才产生向量记录。
3. 新来源版本、审核版本或 Embedding 版本应生成新的快照/记录，并更新对应目标 SPU 的 `vector_currents`。
4. 旧向量记录不应直接覆盖为不可追溯的内容；不再生效的记录通过 `deleted_at`/`delete_after` 进入软删除和延迟物理清理流程。
5. 查询 schema `2.0` 时，应只返回未软删除且属于当前快照的记录。
6. SPU Markdown 的版本和当前文件由 MinIO 的导出记录及 `current.json` 管理，不由 `vector_currents` 替代。

## 11. 推荐查询

### 11.1 查询某个 SPU 当前有效 Chunk

```sql
SELECT r.document_id,
       r.chunk_id,
       r.target_spu_id,
       r.spu_id,
       r.target_spu_ids,
       r.scope,
       r.document_type,
       r.source_document_version,
       r.final_text,
       r.source_segments,
       r.content_payload
FROM rag.vector_records_v2_d1024 AS r
LEFT JOIN rag.vector_currents AS c
  ON c.target_id = r.target_id
 AND c.document_id = r.document_id
 AND c.spu_id = r.target_spu_id
WHERE r.target_id = $1
  AND r.target_spu_id = $2
  AND r.deleted_at IS NULL
  AND (r.vector_snapshot_id IS NULL OR c.snapshot_id = r.vector_snapshot_id)
ORDER BY r.document_id, r.chunk_id;
```

### 11.2 查询某个 SPU 的语义检索结果

```sql
SELECT r.document_id,
       r.chunk_id,
       r.target_spu_id,
       r.final_text,
       r.source_segments,
       r.content_payload
FROM rag.vector_records_v2_d1024 AS r
LEFT JOIN rag.vector_currents AS c
  ON c.target_id = r.target_id
 AND c.document_id = r.document_id
 AND c.spu_id = r.target_spu_id
WHERE r.target_id = $1
  AND r.target_spu_id = $2
  AND r.deleted_at IS NULL
  AND (r.vector_snapshot_id IS NULL OR c.snapshot_id = r.vector_snapshot_id)
  AND r.embedding_profile_id = $3
ORDER BY r.embedding <=> $4::vector
LIMIT $5;
```

查询参数中的 `$4::vector` 必须与 `d1024` 维度一致。不要在日志或公开接口中返回向量本体。

## 12. 交接检查清单

- 确认 PostgreSQL 已启用 `vector` 扩展；
- 确认 `rag.schema_migrations` 存在当前维度迁移记录；
- 确认 `rag.documents` 与 `rag.vector_records_v2_d<dimensions>` 的外键完整；
- 确认 `rag.vector_dimensions` 的目标维度与向量表一致；
- 确认 `rag.vector_currents` 中每个目标 SPU 只有一个当前指针；
- 确认正式查询带有 `deleted_at IS NULL` 和当前快照过滤；
- 确认 `target_spu_id` 与业务确认的 SPU 绑定一致；
- 确认公共 Chunk 的 `scope=common` 和目标范围可追溯；
- 确认未分配/冲突 Chunk 没有被当作正式 SPU 资料导出或入库；
- 确认 MinIO 对象只通过稳定引用关联，数据库没有保存密钥或签名 URL。

## 13. 相关实现

- 表结构和迁移：`src/database-schema.ts`；
- 向量写入、快照和当前指针：`src/database-job.ts`；
- SPU 目录模型：`src/spu-catalog.ts`、`src/workspace.ts`；
- SPU Markdown/Manifest/MinIO 导出：`src/spu-material-export.ts`、`src/server.ts`；
- 通用数据库参考：`docs/rag-database-schema-reference.md`。
