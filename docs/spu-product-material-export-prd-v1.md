# SPU 商品资料导出 PRD V1.1

## 1. 文档状态

- 状态：V1 已上线；V1.1 方案已确认，进入实现与验收
- 版本：V1.1
- 适用范围：Chunk Lab 当前 Source Document 工作区
- 当前不包含：Wiki 同步、完整商品主数据管理、批量跨文档合并

## 2. 背景与目标

当前系统已经能够把 Source Document 解析、规范化、切分为可审核 Chunk，并为后续 RAG 生成 `embeddingText`。需要在向量化之前增加一条独立的商品资料输出路径：

```text
已审核 Chunk
  ├─ 生成 Markdown 商品资料 -> MinIO
  └─ 生成 embeddingText -> 向量库
```

Markdown 用于商品资料阅读、归档和未来 Wiki 对接；向量库用于检索。两者共享同一份已审核 Chunk 快照，但相互独立、分别生成、分别记录状态。

## 3. 非目标

- 本版本不对接 Wiki，不自动创建或更新 Wiki 页面。
- 本版本只维护资料归属所需的最小 SPU 与类目登记，不建设商品目录、ERP 同步或 SKU 变体关系。
- 本版本不把多份 Source Document 自动合并成一份 Markdown。
- 本版本不允许工作人员临时选择部分 Chunk 导出。
- 本版本不从 Markdown 反向解析 Chunk 或重建向量数据。

## 4. 领域模型

### 4.1 SPU

SPU 是商品资料的聚合主键。同一个 SPU 可以拥有多份不同来源或不同类型的商品资料。

```text
SPU-MOUSE-7K2M9Q4D
  ├─ 说明书
  ├─ 参数表
  ├─ 安装指南
  └─ 售后政策
```

SPU ID 使用以下固定格式：

```text
SPU-{CATEGORY_CODE}-{SHORT_CODE}
```

- `CATEGORY_CODE` 是 2～8 位大写英文字母；
- `SHORT_CODE` 是系统随机生成的 8 位 Crockford Base32 字符，并在持久化时检查唯一性；
- 填写商品名称和大类后可以预览候选 ID，只有点击“确认并使用”才正式持久化；
- 已确认的 SPU ID 永久不变，商品大类同时锁定；商品名称、品牌、型号/系列可以后续修订，但不得改变 SPU ID。

最小 SPU 字段：

```text
productName       必填
categoryId        必填
brand             选填
modelSeries       选填
```

类目通过可搜索选择器选择。缺少类目时允许行内新增，系统提供类目编码建议，用户确认后保存。本版本不增加独立类目管理后台。

填写商品名称和大类后，系统最多展示 3 个疑似已有 SPU。工作人员可以选择“使用此 SPU”或“仍然创建新 SPU”；系统不得自动合并，也不得因疑似重复强制阻断创建。

### 4.2 商品资料文档

一份商品资料文档由以下身份共同确定：

```text
spuId
sourceDocumentId
sourceDocumentVersion
documentType
```

同一个 SPU 和同一个 `documentType` 可以存在多份资料，例如中文说明书和英文说明书；不得仅用 `spuId + documentType` 作为唯一键。

### 4.3 文档类型

V1 使用固定枚举：

```text
manual          说明书
specification   参数表
installation    安装指南
after_sales     售后政策
mixed           混合资料
other           其他
```

文档类型必须在生成 Markdown 前由工作人员确认。系统可以提供候选值，但自动识别结果不能直接作为正式归类。

### 4.4 SPU 绑定

Source Document 可以默认绑定一个或多个 SPU。Chunk 可以继承文档级绑定，也可以在多 SPU 文档中覆盖为：

```text
spu-specific   仅属于指定 SPU
common         可复制到相关 SPU
```

多 SPU 文档必须以 Chunk 级范围为准，不能把整份文档无条件复制给每个 SPU。

Chunk 的 SPU 绑定状态必须明确：

```text
unassigned   尚未确定归属，阻断相关 SPU 导出
assigned     已绑定一个或多个具体 SPU
common       已确认属于文档声明的公共范围
conflicted   自动识别或人工绑定冲突，阻断相关 SPU 导出
```

`unassigned` 和 `conflicted` Chunk 不能静默复制、遗漏或归入 `common`。

## 5. 已确认业务规则

1. 一个 Source Document 默认生成一份 Markdown；不自动跨 Source Document 合并。
2. 一份 Source Document 关联多个 SPU 时，为每个已确认 SPU 生成独立 Markdown 输出，并为每个 SPU 返回独立结果。
3. `common` Chunk 可以复制到多个 SPU 的 Markdown，Manifest 必须保留 `scope=common`。
4. Markdown 导出和向量化使用两个独立按钮、两个独立任务和两个独立状态。
5. Markdown 导出作用范围是当前 Source Document，不是整个 SPU 或整个 Parse Batch。
6. 不支持按 Chunk 临时选择导出；一次导出使用当前 Source Document 的完整审核结果。
7. 所有 Chunk 必须有最终处理状态后才能导出：已完成且可发布的 Chunk 进入正文，已完成但不可发布的 Chunk 被排除并记录原因。
8. `documentPublishEligible` 与 `embeddingEligible` 独立判断。
9. Markdown 使用 `finalText` 和结构化内容渲染；Context 默认不进入正文。
10. Markdown 是派生阅读表示，不替代 `Chunk`、`Source Segment`、结构化表格和原始文件。
11. 历史导出版本不可变；重新生成创建新版本，成功后更新 `current.json`。
12. Chunk 或来源版本变化后，相关 Markdown 和向量版本分别标记为 `stale`。

## 6. Chunk 状态与导出资格

Chunk 的基础审核状态：

```text
pending -> reviewing -> completed
reviewing -> failed
completed -> reviewing   // 内容被重新修改
failed -> reviewing      // 修复或重试后重新审核
```

导出时使用以下组合判定：

| 审核状态 | `documentPublishEligible` | Markdown 行为 |
|---|---:|---|
| `completed` + resolved SPU scope | `true` | 纳入正文 |
| `completed` + resolved SPU scope | `false` | 排除并记录原因 |
| `pending` | 任意 | 阻断导出 |
| `reviewing` | 任意 | 阻断导出 |
| `failed` | 任意 | 阻断导出 |
| 任意状态 + `unassigned`/`conflicted` scope | 任意 | 阻断相关 SPU 导出 |

导出结果：

```text
complete
complete_with_exclusions
blocked
failed
```

持久化模型保持两层：`reviewStatus` 使用 `pending/reviewing/completed/failed`，SPU 范围使用 `assigned/common/unassigned/conflicted`，`documentPublishEligible` 决定发布投影。`completed_published` 和 `completed_excluded` 只用于导出结果展示，不替代上述字段。

## 7. 用户流程与 UI

### 7.1 资料归属 SPU

“资料生成”区域提供紧凑的“资料归属 SPU”模块，不增加独立商品管理页面。工作人员可以：

1. 填写商品名称、大类以及选填的品牌、型号/系列；
2. 查看候选 SPU ID 和最多 3 条疑似已有 SPU；
3. 选择已有 SPU，或确认创建并使用新 SPU；
4. 将确认结果加入“已选 SPU”列表，并继续添加其他 SPU；
5. 从当前资料范围移除 SPU，但不得因此删除 SPU 主记录。

一份 Source Document 可以选择多个 SPU，但每个 SPU 必须独立生成 Markdown、Manifest、状态和对象 Key。文档类型继续由工作人员人工确认。

已选 SPU 列表必须显示：

```text
spuId
productName
documentType
finalFileName
```

原“确认文档范围”按钮改为“确认资料归属”。只有至少选择一个 SPU、文档类型已确认，并且每个 SPU 均获得最终文件名预览时才能确认。

### 7.2 前置确认

Markdown 按钮只有在以下条件满足时可用：

- Source Document 解析和切分完成；
- 文档类型已确认；
- 至少一个 SPU 绑定已确认；
- 所有 Chunk 均为 `completed` 且每个目标 SPU 的 scope 已解析；存在 `pending`、`reviewing`、`failed`、`unassigned` 或 `conflicted` Chunk 时阻断相关导出；
- 当前工作区不是 Legacy 数据。Legacy 指缺少本 PRD 所需的规范模型、资格字段或来源视图信息的数据，只允许只读查看和旧契约导出。

如果存在 `pending`、`reviewing` 或 `failed` Chunk，Markdown 按钮禁用并显示数量；如果存在 `completed` 但不可发布的 Chunk，按钮可用，但生成前显示排除数量和原因。

向量按钮使用独立门槛：只消费 `embeddingEligible=true` 且存在有效 `embeddingText` 的 Chunk；不因 `documentPublishEligible=false` 阻断，也不读取 Markdown 状态。`embeddingEligible=false` 的 Chunk 记录排除原因，不生成向量。

### 7.3 两个独立按钮

```text
[生成 Markdown]
[生成向量]
```

两个按钮分别创建：

```text
MarkdownExportJob
EmbeddingJob
```

一个任务失败不得改变另一个任务的状态。两个任务都支持独立重试。

### 7.4 Markdown 状态

```text
not_started
blocked
generating
complete
complete_with_exclusions
failed
stale
```

### 7.5 向量状态

```text
not_started
generating
complete
failed
stale
```

## 8. Markdown 组装规则

1. 使用当前 Source Document Version 的已审核 `finalText`。
2. 按原文阅读顺序、章节层级和 `parentSectionId` 排列。
3. 相邻 Chunk 的 overlap 只保留一次：按 Source Segment 的来源范围排序，计算相邻文本的最大后缀/前缀重叠，删除后一个 Chunk 的重复前缀；无法证明为同一连续来源范围时不去重并保留原文。
4. 不跨非连续 Source Segment 强行拼接。
5. 表格从结构化 Table Artifact 渲染为 Markdown 表格；Markdown 不是表格事实源。
6. 图片引用 MinIO 对象，不内嵌 Base64，不写长期公开 URL。
7. 原始 MinerU HTML/JSON、诊断字段和运行时秘密不得进入 Markdown。
8. `contextText` 默认不进入 Markdown；如未来需要展示，必须增加明确的产品配置和标识。
9. 文档顶部统一补充 SPU、文档类型、来源版本和导出版本；正文标题保留已审核标题。

示例：

```md
# 商品资料

- SPU: SPU-10001
- 文档类型: manual
- 来源文档: source-001
- 来源版本: v3
- 导出版本: v1

## 产品概述

...

## 核心参数

| 参数 | 数值 | 备注 |
|---|---|---|
| 额定电压 | 220V | - |

## 图片资料

![产品结构图](asset://minio/spu/SPU-10001/assets/img-001.png)
```

## 9. MinIO 对象与版本

最终 Markdown 文件名使用：

```text
{spuId}_{documentType}_{sourceBaseName}_{exportVersion}.md
```

`sourceBaseName` 使用原始来源文件名去掉扩展名后的 ASCII 安全化文本；空白与不适合作为对象名的字符统一替换为 `-`，连续分隔符合并。来源名包含非 ASCII 字符时追加 8 位确定性摘要，避免不同中文名称安全化后发生混淆；结果不能为空。界面预览名、MinIO 对象名和下载文件名必须一致。

```text
spu/{spuId}/documents/{sourceDocumentId}/types/{documentType}/sources/{sourceDocumentVersion}/
  exports/{exportVersion}/{finalFileName}
  exports/{exportVersion}/manifest.json

spu/{spuId}/documents/{sourceDocumentId}/current.json
```

规则：

- `exports/{exportVersion}` 是不可变目录；
- 相同输入再次生成时幂等返回已有导出；
- 只有显式“重新生成”才创建新的导出版本；
- 生成成功后原子更新文档级 `current.json`，其中同时指向 `sourceDocumentVersion` 和 `exportVersion`；
- 旧版本保留只读，用于审计和回放。
- V1 已生成的 `material.md` 保持原 Key 只读可访问；V1.1 只影响新生成版本，`current.json` 始终通过完整 Key 指向实际 Markdown 对象。

`current.json` 位于文档级目录，内容至少为：

```json
{
  "spuId": "SPU-10001",
  "sourceDocumentId": "source-001",
  "documentType": "manual",
  "sourceDocumentVersion": "v3",
  "exportVersion": "v1",
  "documentObjectKey": ".../v3/exports/v1/SPU-MOUSE-7K2M9Q4D_manual_a1-manual_v1.md",
  "manifestObjectKey": ".../v3/exports/v1/manifest.json"
}
```

图片对象使用稳定的内部引用：

```text
asset://minio/{objectKey}
```

页面或未来 Wiki 适配层再将其转换为短期访问地址。

## 10. Manifest 契约

```json
{
  "contractVersion": "spu-document-export-1",
  "spuId": "SPU-10001",
  "sourceDocumentId": "source-001",
  "sourceDocumentVersion": "v3",
  "documentType": "manual",
  "exportVersion": "v1",
  "status": "complete_with_exclusions",
  "includedChunks": [
    {
      "chunkId": "chunk-001",
      "order": 1,
      "scope": "spu-specific",
      "targetSpuIds": ["SPU-10001"],
      "sourceSegments": [],
      "assetRefs": [],
      "tableVersionIds": []
    },
    {
      "chunkId": "chunk-004",
      "order": 2,
      "scope": "common",
      "targetSpuIds": ["SPU-10001", "SPU-10002"],
      "sourceSegments": [],
      "assetRefs": [],
      "tableVersionIds": []
    }
  ],
  "excludedChunks": [
    {
      "chunkId": "chunk-002",
      "scope": "spu-specific",
      "targetSpuIds": ["SPU-10001"],
      "reason": "document_publish_ineligible"
    }
  ],
  "generatorVersion": "exporter-v1",
  "contentHash": "sha256:...",
  "generatedAt": "2026-08-25T00:00:00.000Z"
}
```

Manifest 必须能够回答：

- 当前 Markdown 属于哪个 SPU；
- 来自哪个 Source Document Version；
- 使用了哪些 Chunk；
- 哪些 Chunk 被排除以及原因；
- 生成器版本和内容哈希是什么。

`includedChunks` 的 `order` 是 Markdown 中的确定性顺序；`sourceSegments` 至少保存 `contentBlockId`、页码或源码范围、bbox（如有）、`chunkStart`/`chunkEnd` 和定位质量；`assetRefs` 至少保存 `assetId`、MinIO `objectKey`、媒体类型和来源 Block；`tableVersionIds` 指向不可变表格版本。正文不承担完整审计职责。

## 11. 向量记录契约

向量任务只消费 `embeddingText`，不得读取 Markdown 再反向切分。每条向量记录至少包含：

```json
{
  "spuId": "SPU-10001",
  "sourceDocumentId": "source-001",
  "sourceDocumentVersion": "v3",
  "documentType": "manual",
  "chunkId": "chunk-001",
  "chunkRevision": "r5",
  "embeddingTextHash": "sha256:..."
}
```

重新生成 Markdown 不修改向量；只有新的 EmbeddingJob 成功后才切换向量 current 版本。
向量 current 必须按 `spuId + sourceDocumentId + sourceDocumentVersion + embeddingModel + embeddingRevision` 唯一标识；只有该批次全部目标记录写入并校验成功后才能切换 current，失败或部分写入不得切换。

实现边界必须保持现有链路：`EmbeddingJob` 负责生成和校验向量输入，`DatabaseJob/VectorRepository` 负责持久化向量记录、建立不可变 vector snapshot/version 并原子切换 current。多 SPU 的 `common` Chunk 按每个目标 SPU 生成一条带 `targetSpuId` 的向量记录，保留 `scope=common`；幂等、删除和 current 选择均按目标 SPU 区分。

## 12. 幂等、失效与错误处理

幂等键由以下字段组成：

```text
spuId
targetSpuIds (sorted)
sourceDocumentId
sourceDocumentVersion
documentType
reviewRevision
exportConfigVersion
```

内容哈希覆盖规范化后的 Manifest 输入：SPU、来源版本、文档类型、Chunk 顺序、Chunk `finalText`、scope/targetSpuIds、Source Segments、表格版本和资产引用；不包含生成时间、短期 URL 或任务 ID。

相同输入重复点击“生成 Markdown”时返回已有结果。服务端必须以幂等键建立唯一约束或等价锁，避免并发点击创建多个版本。显式重新生成才创建新 `exportVersion`。

以下变化会使 Markdown 标记为 `stale`：

- Chunk `finalText` 改变；
- Chunk 顺序或章节关系改变；
- SPU 绑定改变；
- 文档类型改变；
- 表格版本或图片关联改变；
- Source Document Version 改变。

失败时不得写入伪造的成功 `current.json`。任务应保存可展示的错误原因，并允许独立重试。

## 13. 建议接口

接口名称以现有服务端路由风格为准，语义至少包括：

```text
POST /api/source-documents/:documentId/markdown-export
POST /api/source-documents/:documentId/embedding
GET  /api/source-documents/:documentId/downstream-status
GET  /api/spus/:spuId/documents
GET  /api/spu-categories?query=...
POST /api/spu-categories
GET  /api/spus?query=...&categoryId=...
POST /api/spus/preview
POST /api/spus
```

`POST /api/spus/preview` 只返回候选 ID 与疑似重复项，不占用编号。`POST /api/spus` 在确认时重新检查 ID 唯一性，必要时生成新的 `SHORT_CODE`；同一次确认请求必须幂等返回同一 SPU。

Markdown 导出请求不接收 `selectedChunkIds`。服务端根据当前审核快照计算完整导出范围，并返回一个任务及每个目标 SPU 的结果：

```json
{
  "jobId": "job-001",
  "results": [
    {
      "spuId": "SPU-10001",
      "status": "complete",
      "sourceDocumentVersion": "v3",
      "exportVersion": "v1",
      "manifestObjectKey": "..."
    }
  ]
}
```

某个 SPU 失败不得伪造其他 SPU 成功；结果必须按 SPU 独立记录。任务整体状态只能由所有 per-SPU 结果汇总得出，并保留每个 SPU 的错误原因。

## 14. 验收标准

1. 一个 SPU 可以拥有多份不同来源或不同类型的 Markdown。
2. 同一个 SPU 和文档类型可以存在多个版本，旧版本可只读访问。
3. 多 SPU Source Document 能按 Chunk 范围生成对应 SPU 文档，并为每个 SPU 返回独立的状态、版本和对象 Key。
4. `common` Chunk 能进入多个相关 SPU 文档，Manifest 标记其公共范围。
5. `unassigned` 或 `conflicted` Chunk 会阻断受影响 SPU 的 Markdown 导出，不会被静默归入 `common`。
6. 存在 `pending`、`reviewing` 或 `failed` Chunk 时，Markdown 按钮不可用。
7. 已完成但不可发布的 Chunk 被排除并写入 Manifest，结果显示 `complete_with_exclusions`。
8. Markdown 和向量化按钮、任务、状态、重试彼此独立。
9. 向量按钮只处理 `embeddingEligible=true` 且有有效 `embeddingText` 的 Chunk；不因 Markdown 排除项而阻断。
10. Markdown 不包含原始 MinerU HTML/JSON、Base64 图片、长期预签名 URL 或运行时秘密。
11. Markdown 生成后按 SPU 原子更新文档级 `current.json`；失败不能更新对应 SPU 的 current。
12. Chunk 修改后 Markdown 和向量状态分别变为 `stale`。
13. 相同输入并发生成只产生一个导出版本，显式重新生成才创建新版本。
14. 相邻连续来源的 overlap 按确定性规则去重，非连续来源不被强行拼接。
15. 向量记录能够回溯到 SPU、Source Document Version、文档类型和 Chunk。
16. 向量只有在目标记录完整写入并校验成功后才切换 current；部分失败不切换。
17. 工作人员可以在资料生成区域创建最小 SPU、搜索并复用已有 SPU，不需要手工输入 SPU ID。
18. 新 SPU 符合 `SPU-{CATEGORY_CODE}-{8 位 SHORT_CODE}`，确认后 ID 与大类不可修改。
19. 疑似重复结果最多显示 3 条，用户仍可明确创建新 SPU，系统不自动合并。
20. 已选多个 SPU 时，每个 SPU 显示独立的最终 Markdown 文件名预览。
21. 新导出的 MinIO Markdown 对象名与界面预览、下载文件名一致，不再统一使用 `material.md`；历史对象继续可读。

## 15. 后续扩展

- Wiki 草稿预览与同步；
- SPU 级跨文档目录；
- 多语言资料聚合；
- 发布审批和 Wiki 冲突检测；
- SPU 级批量重新生成。
