# 表格处理策略：从文档解析到普通检索与未来 Deep Retrieval

本文说明 Issue 14 的完整表格数据流、数据模型、检索边界和设计取舍，并提供一套面试大厂时可以自然讲述的项目答案。

## 1. 核心结论

表格不是一段应该被完整塞进向量库的长文本，而是一份需要长期保持结构和来源关系的事实数据。

系统将它拆成三层：

1. **Table Artifact**：表格的权威结构化事实，保存列、行、单元格关系、行组和来源定位。
2. **Table Version**：一次经过人工审核的不可变表格版本。logical_table_id 标识同一张逻辑表，table_version_id 标识一个不可变版本。
3. **Table Retrieval Bundle**：面向普通语义检索的代理文本。它只由有序关联文字 Chunk、最终审核摘要和必要身份信息构成，并为一个 Table Version 生成一条向量。

核心原则：

> 结构化事实归 Artifact，语义发现归 Bundle，精确行列查询留给未来 Deep Retrieval。

表格正文、Markdown、渲染 HTML 和 rawTableHtml 不进入普通 Embedding 输入；关联文字 Chunk 也不再单独生成普通表格向量。

## 2. 全链路数据流

~~~text
原始 PDF / 文档
      |
      v
远程 MinerU 解析
      |
      v
Parsed Document / Content Blocks
      |
      v
Table Chunk + 文本 Chunk + source location
      |
      v
人工审核 TableModel、摘要、关联文字和顺序
      |
      +------------------------------+
      |                              |
      v                              v
Table Artifact JSONB             Table Version
列/行/单元格/行组/来源             immutable identity
      |                              |
      +--------------+---------------+
                     v
          Table Retrieval Bundle
          有序文字 + 最终摘要 + 身份
                     |
                     v
          一次远程 Embedding 调用
                     |
                     v
       一条 dimension-specific pgvector
                     |
                     v
普通检索命中 Bundle
      |
      +------------------------------+
      |                              |
      v                              v
返回摘要、文字和元数据          按 table_version_id lazy-load
                                  完整 Table Artifact

未来具体参数/比较问题
                     |
                     v
             Deep Retrieval seam
                     |
                     v
        Table Version 关系投影中的行列查询
~~~

## 3. 分阶段处理策略

### 3.1 原始文档与远程解析

原始 PDF 是事实来源，Markdown 不是唯一真相。文档进入解析流程后，由远程官方 MinerU 生成结构化结果：页面和块级内容、表格块及页面定位、候选列行单元格关系，以及与表格相邻的文本块。

MinerU 负责解析，不负责最终业务事实确认。跨页表格、重复表头、合并单元格或来源定位问题都必须进入人工审核。

### 3.2 Table Chunk 与人工审核

在 Chunk 边界，内容类型仍是 text、table、image。Table Chunk 是独立审核对象，包含候选结构和来源定位。

人工审核确认列名和顺序、数据行和单元格文本、rowSpan/colSpan 关系、跨页表头归属、行组来源、最终表格摘要，以及与表相关的文本 Chunk 和显式顺序。解析器或模型的候选摘要不能未经确认直接进入普通检索。

### 3.3 Table Artifact

Table Artifact 是 PostgreSQL JSONB 中的权威结构化对象：

~~~text
type: table
tableId
title?
columns[]
rows[][]
  cellId
  text
  rowSpan
  colSpan
rowGroups[]
  rowGroupId
  order
  repeatedHeader
  sourceSegmentIds[]
  rowStart
  rowCount
sourceSegments[]
  id
  page
  bbox
~~~

Artifact 保存结构化事实和可追溯关系，不保存普通检索向量。Markdown 和 rendered HTML 是派生视图；rawTableHtml 只作为诊断输入，不能成为权威内容。

### 3.4 不可变 Table Version

Table Version 解决“表格编辑后旧结果指向什么内容”的问题：

~~~text
logical_table_id  -> 同一逻辑表的稳定身份
table_version_id  -> 某次审核状态的不可变身份
state             -> staged / active / soft_deleted
created_at
deleted_at?
query_ready
query_ready_at?
~~~

版本创建时复制审核后的 Artifact 快照，不在旧版本上原地修改。表格内容、关联文字版本、关联顺序或最终摘要变化，都创建新的 table_version_id。

版本同时记录 source_chunk_id、source_chunk_version、order、final_text。order 是业务确认顺序，不是数据库自然顺序。

### 3.5 query_ready 基础校验

query_ready 不是模型自动推断的状态，而是人工确认开关。服务端确认接口至少检查：有列、有数据行、列名非空且不重复、单元格行列关系有效、行组覆盖数据行、行组和单元格可追溯到来源定位。

校验失败保持 queryReady=false。结构或来源变化时创建新版本，新的版本重新等待确认。

### 3.6 Table Retrieval Bundle

Bundle 是普通检索的语义代理，不是 Artifact 的复制品。拼接顺序固定为：

1. 按显式 order 排序的关联文字 Chunk；
2. 最终审核表格摘要；
3. 可选的表格标题等身份信息。

示意：

~~~text
[关联文字 1]
该章节介绍消费电子产品的主要规格差异。

[关联文字 2]
不同产品系列面向不同价格和性能区间。

[表格摘要]
2025 年智能手机、笔记本、耳机和平板产品的技术参数对比表。

[表格身份]
产品技术参数对比表
~~~

明确排除表格单元格正文、表格 Markdown、rendered HTML、rawTableHtml 和未经审核的模型摘要。最终文本使用 SHA-256 生成 embedding_input_hash，用于审计和重建一致性。

### 3.7 一次 Embedding，一条 Bundle 向量

一个当前 Table Version 只产生一个 Bundle 和一条向量，记录 embedding_input_text、embedding_input_hash、profile、model、dimensions、embedding、source_chunk_ids 和 vector_ready。

关联文字只作为 Bundle 来源，不额外生成独立普通向量。vector_ready 必须同时满足输入非空、Embedding 成功、维度匹配和向量成功持久化。无关联文字但有有效摘要时仍可生成 Bundle；两者都为空时不生成向量。

### 3.8 PostgreSQL + pgvector

Issue 14 使用 PostgreSQL 作为唯一持久化边界，不引入 MongoDB：

| 数据 | 存储 | 作用 |
|---|---|---|
| Table Artifact / Version | rag.table_artifacts JSONB | 权威内容、版本身份、状态、摘要、query-ready |
| Version 与文字关系 | rag.table_version_source_chunks | Chunk、Chunk 版本和顺序 |
| Bundle 向量 | rag.table_retrieval_bundles_v1_d<dimension> | 一条向量、输入 hash、profile、source IDs、ready 状态 |
| 历史版本 | 软删除字段 | 审计、回滚和延迟清理 |

采用 additive migration 2.1：不改写 schema 2.0，不删除旧 rag_vector_records_v1，也不把新 Bundle 塞回旧 Chunk 向量表。维度放进表名并在列上使用 vector(dimension)，避免不同模型维度混用。

### 3.9 版本替换顺序

~~~text
1. 保存新的 staged Table Version
2. 生成新的 Bundle
3. 写入新的 Bundle 向量
4. 新 Bundle 成功后，软删除旧版本和旧 Bundle
5. 激活新版本
~~~

Embedding 失败、维度不匹配或 Bundle 写入失败时，旧 active 版本继续可检索。旧版本保留但不再进入当前检索。

## 4. HTTP 边界

### 创建或替换版本

POST /api/table-retrieval/versions 接收审核后的 Model/Artifact、最终摘要、关联文字和来源定位。响应返回版本元数据、Bundle ID、输入 hash、source IDs 和 vectorReady，不返回向量值。

### 普通检索

POST /api/table-retrieval/search 只返回 table_version_id、逻辑表和表格元数据、最终摘要、关联文字 Chunk、相似度分数。不返回向量、完整 Artifact、原始 HTML 或图片二进制。

### lazy-load 完整表格

GET /api/table-retrieval/versions/:tableVersionId 只有在用户明确请求展示时，才加载完整列、行、单元格、行组和来源定位，避免普通检索响应随表格大小膨胀。

### 人工确认 query-ready

POST /api/table-retrieval/versions/:tableVersionId/query-ready 执行基础结构校验。失败保持关闭，成功后记录人工确认时间。

## 5. 设计取舍

直接嵌入表格全文会导致大表重复存储、版本更新不一致、重复命中和难以解释。Bundle 只负责“发现这张表”，Artifact 负责“展示这张表”，未来关系投影负责“精确查这张表”。

普通检索流程是：用户问题 -> 远程 Query Embedding -> Bundle pgvector 相似度搜索 -> 当前 active Table Version -> 摘要、关联文字和元数据 -> 用户选择后 lazy-load Artifact。

如果参数只存在于表格正文、不在摘要或关联文字中，普通语义检索可能发现不了它。这是明确边界，等待未来 Deep Retrieval。

## 6. Deep Retrieval 边界

Deep Retrieval 可在 query_ready=true 的版本上建立关系投影，查询具体行、列、参数、筛选和比较条件，并返回来源定位。

Issue 14 只保留 seam，不实现 NL2SQL、意图识别、SQL 生成、AST 安全校验、只读执行器、LIMIT、超时、行级权限、完整类型推断、单位归一化和列本体映射。

## 7. 真实文档验收

真实验收使用 materials/pdf/产品技术白皮书.pdf：

- 远程 MinerU 解析真实 PDF；
- 实际表格验证为 11 列、35 行；
- 远程 Embedding 生成一次 Bundle 向量和一次查询向量；
- 写入远程 PostgreSQL + pgvector；
- 验证普通检索、query-ready 和 lazy-load；
- 只记录 checksum、数量、状态和公开响应字段。

证据不记录凭证、请求头、远程 URL、原始 HTML、图片二进制或向量值。

## 8. 面试大厂怎么讲：自然 STAR

不要先背四个英文标题，先讲问题，再自然带出背景、目标、动作和结果。

### 一分钟版本

“这个项目里，表格原来被当成长文本处理，表格正文、摘要和向量混在一个记录里。大表会被重复塞进向量存储，表格改版后旧向量容易指向错误内容，多个关联文本命中同一张表时还会产生重复结果。

我的处理方式是把表格拆成事实层和检索层。事实层用不可变的 Table Version 保存审核后的 JSONB Artifact，logical_table_id 标识逻辑表，table_version_id 标识具体版本；检索层把有序关联文字和最终审核摘要组成一个 Bundle，每个版本只生成一次 Embedding 和一条 pgvector。普通检索只返回版本元数据、摘要和关联文字，用户需要展开时再 lazy-load 完整表格。

版本替换时先写新版本和新向量，成功后再软删除旧版本，避免更新失败导致线上没有可用结果。最后用真实 PDF 走远程 MinerU、远程 Embedding 和远程 PostgreSQL 验证了 11 列 35 行表格，确认向量调用次数、版本替换和 HTTP 脱敏边界。Deep Retrieval 只定义了 query-ready 和关系投影边界，没有把 NL2SQL 等未完成能力冒充成已实现。”

### 追问展开

**Situation：** 原模型把结构化表格同时当作事实和向量文本，缺少版本身份和来源关系。

**Task：** 建立可追溯、可版本化的表格事实模型；让普通检索有统一 Bundle；保证更新失败时旧版本继续服务；为精确查询留下入口。

**Action：**

1. Artifact、Version、Bundle 分别承担事实、版本和检索职责；
2. 按显式顺序拼接关联文字，再拼接最终摘要和身份信息，并保存 hash；
3. 排除表格正文、HTML 和 raw HTML；
4. 一版本一 Bundle 一向量，关联文字不生成独立普通向量；
5. 新版本和新向量成功后才软删除旧版本；
6. 普通搜索与完整 Artifact 使用不同 HTTP 边界；
7. PostgreSQL 同时承载 JSONB、关系和 pgvector，不增加第二数据库。

**Result：** 一个版本只生成一个 Bundle 向量，旧版本保留但不再进入当前搜索，vector_ready 自动计算，query_ready 由人工确认。真实 PDF 远程验收为 11 列 35 行，远程 Embedding 两次调用，远程 pgvector 能检索新版本，HTTP 响应不包含向量和 raw HTML。

### 高频追问

**为什么用 table_version_id 而不是只有 table_id？**  
table_id 只说明是哪张逻辑表，不能保证内容不可变。检索、审计和来源引用必须指向确定快照，所以采用两层身份。

**为什么旧版本不物理删除？**  
为了更新失败时保留服务能力，也支持审计、回滚和延迟清理。当前搜索通过 active 与未删除条件排除旧版本。

**如何避免重复命中？**  
关联文字不单独生成表格向量，而是进入一个 Bundle；每个当前版本只有一条 Bundle 向量。

**如何保证输入可复现？**  
关联关系有显式顺序；相同版本、来源版本、摘要和 profile 生成相同输入和 hash；记录同时保存 profile、model、dimensions。

**为什么 query-ready 不自动开启？**  
结构校验只能证明形状基本有效，不能替代业务人员对列含义、单位和查询适用性的确认。

**为什么不让 LLM 直接读完整表格？**  
普通语义检索适合发现，不适合保证精确行列条件。结构化事实应通过关系投影查询，再交给回答层。

**代价是什么？**  
参数只存在于表格正文时，普通检索可能发现不了；lazy-load 会多一次请求。这是换取一致性、低重复和可解释性的明确代价。

## 9. 当前状态与路线

### 已实现

- Table Artifact、Table Version、Table Retrieval Bundle；
- logical_table_id 和不可变 table_version_id；
- 确定性 Embedding 输入和 hash；
- 单 Bundle 向量；
- 关联文字不生成独立普通向量；
- vector_ready 和人工确认的 query_ready；
- PostgreSQL JSONB + dimension-specific pgvector；
- 安全版本替换和旧版本软删除；
- 普通检索、lazy-load、query-ready HTTP 边界；
- 真实 PDF 的远程 MinerU、远程 Embedding、远程 PostgreSQL/pgvector 验收。

### 未实现

- Deep Retrieval 关系投影查询；
- NL2SQL、意图识别、SQL AST 安全校验；
- SQL 只读执行、LIMIT、超时和行级权限；
- 完整类型推断、单位归一化、列本体映射。

### 后续顺序

1. 建立带 table_version_id 的列、行、单元格关系投影；
2. 定义只读查询 API 和权限边界；
3. 评估意图识别到 Deep Retrieval 的路由；
4. 补充超时、缓存、解释和审计策略。

## 10. 一句话收尾

“我没有把表格简单当成另一种文本，而是把它建模成可追溯、可版本化的结构化事实，再用一个轻量、确定性的 Bundle 接入普通检索；这样当前搜索可用，历史数据安全，未来也能自然演进到精确的 Deep Retrieval。”

