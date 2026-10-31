# SPU 知识库 Markdown 与渐进式披露设计

## 1. 文档目的

后期知识库以 **SPU** 为业务聚合粒度，将经过人工审核的 Chunk 按文档类型、章节层级和阅读顺序组装成独立的 SPU Markdown 文档，提供给售前咨询、生图平台和其他商品业务使用。

核心设计不是把所有资料一次性发送给大模型，而是：

```text
审核后的 Chunk
  -> 按 SPU 和文档类型生成 Markdown
  -> 建立 SPU 文档目录和索引
  -> 根据业务问题渐进式披露
  -> 只向大模型加载当前回答所需的文档内容
```

## 2. 业务对象：SPU 而不是 SKU

SPU 是商品资料的聚合主键。同一个 SPU 可以拥有多份不同来源、不同语言或不同类型的资料：

```text
SPU-COOKER-7K2M9Q4D
  ├─ manual          说明书
  ├─ specification   参数表
  ├─ installation    安装指南
  ├─ after_sales     售后政策
  └─ other           其他已确认资料
```

一个 Source Document 可以绑定一个或多个 SPU。多 SPU 文档必须按 Chunk 级范围展开：

- `assigned`：只进入指定 SPU；
- `common`：可以复制到声明范围内的多个 SPU；
- `unassigned`：尚未确认归属，阻断相关 SPU 输出；
- `conflicted`：归属冲突，阻断相关 SPU 输出。

不能因为文件名相似，就把整份多 SPU 文档复制给所有 SPU。

## 3. SPU Markdown 的生成来源

SPU Markdown 只从当前 Source Document 的 reviewed Chunk 快照生成：

```text
Source Document Version
  -> Reviewed Chunk Snapshot
  -> documentPublishEligible 校验
  -> SPU scope 展开
  -> 按 documentType / chapter / readingOrder 排序
  -> Markdown Export
  -> MinIO 对象 + Manifest
```

导出使用的主要内容：

- 审核后的 `finalText`；
- 已确认的标题和章节层级；
- 结构化表格的 Markdown 渲染结果；
- 图片的人工确认说明和稳定对象引用；
- 来源文档版本、审核版本和 SPU 归属元数据。

默认不进入正文的内容：

- 未审核 Preview；
- 被排除或归属冲突的 Chunk；
- 未确认的 Context；
- 原始 MinerU JSON、诊断字段和 raw HTML；
- Base64 图片和长期有效的签名 URL；
- 数据库凭证或模型密钥。

`documentPublishEligible` 与 `embeddingEligible` 独立判断：某个 Chunk 可以进入向量检索，不代表它一定应该出现在面向售前或生图业务的 SPU Markdown 中。

## 4. SPU Markdown 推荐结构

每个 SPU、每种资料类型、每个导出版本生成一份独立 Markdown：

```text
SPU ID + documentType + exportVersion
  -> 一个 Markdown 文件
  -> 一个 Manifest
```

示例：

```markdown
# 商品资料

- SPU: SPU-COOKER-7K2M9Q4D
- 文档类型: specification
- 商品名称: 智能料理机
- 品牌: Example Brand
- 来源文档: 产品技术说明书.pdf
- 来源文档版本: source-v2
- 审核版本: review-r56
- 导出版本: v3
- 导出状态: complete_with_exclusions

## 1. 商品概述

由审核后的说明性 Chunk 按阅读顺序拼接。

## 2. 核心参数

| 参数 | 数值 | 单位 | 备注 |
| --- | --- | --- | --- |
| 容量 | 1.5 | L | 以当前审核版本为准 |
| 功率 | 1200 | W | 以当前审核版本为准 |

## 3. 适用范围与限制

- 本文件示例属于 `specification` 类型，正文只承载参数类事实。
- 使用方法、安装步骤和售后政策分别维护在 `manual`、`installation`、`after_sales` 类型的 SPU Markdown 中，不在本文件重复拼接正文。
- 跨类型关联只保留文档索引或引用，真正回答时再按需披露对应类型章节。

## 4. 图片与外观说明

![产品结构图](s3://bucket/spu/SPU-COOKER-7K2M9Q4D/image-v2.png)

图片说明来自人工确认的图片摘要或有效关联文字。

## 5. 关联资料索引

- `manual`：使用方法和清洁说明（按需加载）
- `installation`：安装环境和步骤（按需加载）
- `after_sales`：保修、退换和维修限制（按需加载）

## 6. 来源信息

- SPU: SPU-COOKER-7K2M9Q4D
- Source Document Version: source-v2
- Review Revision: 56
- Included Chunks: chunk-001, chunk-002, chunk-003
- Excluded Chunks: chunk-009
```

正文使用业务可读内容；来源、版本和 Chunk 清单放在头部或 Manifest，方便下游追溯。

## 5. 不同资料类型的职责

| documentType | 主要内容 | 适合回答的问题 | 默认披露优先级 |
| --- | --- | --- | --- |
| `manual` | 使用方法、操作步骤、清洁和日常使用 | 怎么使用、如何操作 | 高 |
| `specification` | 参数、规格、尺寸、功率、容量和型号差异 | 产品参数是什么、能否满足条件 | 高 |
| `installation` | 安装条件、安装步骤、接口和环境要求 | 怎么安装、是否适配现场环境 | 中 |
| `after_sales` | 保修、退换、维修、耗材和服务限制 | 售后怎么处理、保修多久 | 中 |
| `mixed` | 多种资料混合但已确认无法拆分 | 综合问题 | 按章节加载 |
| `other` | 其他已确认商品资料 | 依问题路由 | 低 |

文档类型是业务路由信息，不只是 Markdown 标题。大模型在回答前应先根据问题选择资料类型，再决定是否加载该类型的完整 Markdown 或其中章节。

## 6. 渐进式披露加载

### 6.1 为什么不能一次发送整个 SPU

一个 SPU 可能同时有说明书、参数表、安装指南和售后政策。如果每次问答都把全部 Markdown 发送给大模型，会带来：

- 输入 Token 和调用成本随资料量增长；
- 不同类型内容互相干扰，例如售前参数问题混入售后条款；
- 长文档超出上下文窗口；
- 大模型更难判断事实来自哪一种文档；
- 版本更新后，旧资料可能与新资料同时进入提示词。

因此采用渐进式披露：**按 SPU 下的 documentType 和章节逐层发送，先给最小必要信息，只有当前回答需要时才加载下一层。** 大模型不能自行读取未披露的其他类型文档，是否扩展披露由服务端路由和权限规则决定。

### 6.2 四层加载模型

```text
第 0 层：SPU Catalog / 文档索引
  只包含 SPU 身份、商品名称、型号、可用 documentType、当前版本和章节摘要

第 1 层：问题相关的资料目录
  根据用户问题选择 manual / specification / installation / after_sales 等类型

第 2 层：相关文档章节或 Chunk 摘要
  只加载命中的章节、表格摘要、图片说明和相邻必要内容

第 3 层：精确事实和来源证据
  需要时加载具体表格行、完整段落、图片对象引用、来源页码和版本信息
```

默认不直接加载整个 SPU 的所有正文。只有问题确实需要跨文档综合时，才扩大披露范围，并在每次扩展时记录新增的 documentType、章节、Chunk 和版本。

### 6.3 大模型交互示例

以“这款产品能否放进 600 mm 宽的橱柜，安装有什么要求？”为例：

```text
第 1 次发送（SPU Catalog）
  SPU 身份 + 当前版本 + 可用 documentType + 每类文档的章节摘要
  目的：让模型判断需要 specification 和 installation

第 2 次发送（按类型披露）
  specification/尺寸章节摘要 + installation/环境要求章节摘要
  目的：缩小到相关章节，不发送 manual、after_sales 全文

第 3 次发送（精确证据）
  具体尺寸表格行、接口要求、来源页码、Chunk ID 和版本
  目的：支持最终判断并给出可追溯引用
```

如果第 2 次发送的摘要已经足以回答问题，则不再发送第 3 次内容；如果发现规格和安装要求存在冲突，服务端停止继续综合并返回待人工确认状态。

### 6.4 典型加载流程

```text
用户问题 + SPU ID
  -> 读取 SPU 索引
  -> 判断问题类型
  -> 选择一个或多个 documentType
  -> 加载当前类型目录/章节摘要
  -> 判断是否需要更多事实
  -> 加载相关 Chunk 或表格 Artifact
  -> 生成带来源的回答
```

示例：

```text
问题：这款料理机的容量和额定功率是多少？

第一次加载：SPU 身份 + specification 文档目录
第二次加载：specification/核心参数章节 + 对应表格行
不加载：after_sales、installation、无关 manual 章节
回答：容量 1.5 L，额定功率 1200 W，并标记 specification v3 来源
```

另一个示例：

```text
问题：这个产品适合什么厨房环境，安装有什么要求？

第一次加载：SPU 身份 + installation 文档目录
第二次加载：installation/环境要求和安装步骤章节
按需补充：specification 中的尺寸、电源和接口参数
不加载：after_sales 全文
```

## 7. 给大模型的受控输入

发送给大模型的内容应由服务端根据 SPU、文档类型、版本和权限组装，而不是由前端直接提交一整份文件。

推荐的模型输入结构：

```json
{
  "spuId": "SPU-COOKER-7K2M9Q4D",
  "question": "这款产品的容量和功率是多少？",
  "disclosureLevel": 2,
  "requestedDocumentTypes": ["specification"],
  "documents": [
    {
      "documentType": "specification",
      "exportVersion": "v3",
      "sourceDocumentVersion": "source-v2",
      "sections": [
        {
          "sectionId": "spec-core-parameters",
          "title": "核心参数",
          "content": "容量 1.5 L；额定功率 1200 W。",
          "chunkIds": ["chunk-001", "chunk-002"]
        }
      ]
    }
  ],
  "sourcePolicy": "reviewed_only"
}
```

服务端应保证：

- 只使用当前 SPU 的有效版本；
- 只披露 `documentPublishEligible=true` 的内容；
- 只发送已审核的 `finalText` 或结构化事实；
- 表格优先发送结构化行列事实，而不是 raw HTML；
- 图片优先发送人工确认摘要和稳定对象引用；
- 记录实际披露了哪些文档、章节、Chunk 和版本；
- 不把过期、冲突或未分配内容作为事实依据。

## 8. 售前咨询场景

售前咨询优先使用 `specification`、`manual` 和必要的 `installation` 文档：

```text
规格问题       -> specification
使用问题       -> manual
安装适配问题   -> installation + specification
保修/售后问题  -> after_sales
综合问题       -> 先加载索引，再按需加载多个类型
```

回答中建议携带：

- SPU ID；
- 使用的文档类型；
- 文档版本；
- 章节或来源 Chunk；
- “资料未确认”或“当前资料未覆盖”的明确提示。

如果不同文档类型出现冲突，应优先停止自动综合，返回冲突信息并要求人工确认，而不是让大模型自行选择更符合语言习惯的答案。

## 9. 生图平台场景

生图平台通常需要更稳定的商品事实和视觉约束，可按以下顺序披露：

```text
第 1 层：SPU 身份、品牌、型号
第 2 层：外观、颜色、材质、结构特征
第 3 层：尺寸、容量、接口和需要保持一致的参数
第 4 层：原图对象引用、场景限制和禁止改变的事实
```

生图输入不应把全部售后条款和无关安装说明发送给模型。推荐先生成结构化事实对象，再转换为图像生成提示词：

```json
{
  "spuId": "SPU-COOKER-7K2M9Q4D",
  "productIdentity": {
    "name": "智能料理机",
    "brand": "Example Brand",
    "modelSeries": "EXAMPLE-1500"
  },
  "visualFacts": [
    "白色机身",
    "透明料理杯",
    "黑色控制面板"
  ],
  "stableSpecifications": [
    {"name": "容量", "value": "1.5", "unit": "L"}
  ],
  "sourceDocumentVersion": "source-v2",
  "materialDocumentVersion": "v3"
}
```

大模型只能根据已审核视觉事实生成创意表达，不能自行补充未在 SPU 文档中确认的颜色、材质、尺寸或结构。

## 10. 版本和当前指针

每份 SPU Markdown 都是不可变版本：

```text
SPU
  -> documentType
  -> sourceDocumentVersion
  -> reviewRevision
  -> exportVersion
  -> Markdown object
  -> Manifest
```

新版本生成顺序：

1. 读取 reviewed Chunk 快照；
2. 校验 SPU 归属、文档类型和发布资格；
3. 按章节和阅读顺序拼接 Markdown；
4. 生成 Manifest；
5. 写入 MinIO；
6. 成功后更新当前版本指针。

生成失败时：

- 旧版本继续作为当前版本；
- 新版本记录失败原因；
- 不覆盖旧 Markdown；
- 不让大模型同时看到新旧两个“当前版本”。

当来源文档版本、Chunk 审核版本或发布资格发生变化时，相关 Markdown 和下游披露索引应标记为 `stale`，重新生成成功后才能更新 current。

## 11. 与向量库的关系

SPU Markdown 和向量库共享 reviewed Chunk 快照，但用途不同：

```text
reviewed Chunk snapshot
  ├─ SPU Markdown：面向售前、生图和业务消费
  └─ Embedding：面向语义检索
```

不采用以下链路：

```text
MinerU Markdown -> SPU Markdown -> 反向生成向量
```

正确链路是：

```text
reviewed Chunk snapshot
  -> Markdown Export
reviewed Chunk snapshot
  -> Embedding Job
```

渐进式披露可以同时使用 SPU Markdown 的目录索引和向量检索结果，但向量检索命中后仍要按 SPU、文档类型、版本和发布资格过滤，不能绕过 Markdown 的版本边界。

## 12. 存储建议

| 内容 | 存储位置 | 说明 |
| --- | --- | --- |
| SPU、文档类型、版本、状态、Chunk 关系 | PostgreSQL | 用于查询、版本控制和审计 |
| Markdown 文件、Manifest、图片和导出对象 | MinIO | 使用稳定 object key 和 checksum |
| Chunk 向量和 Bundle 向量 | PostgreSQL + pgvector | 只保存合格向量及其来源元数据 |
| SPU 文档目录/章节索引 | PostgreSQL 或由 Manifest 构建的索引 | 用于渐进式披露第一、二层加载 |

不保存：长期签名 URL、凭证、Authorization、Base64 原图和未审核模型输入。

## 13. 面试 STAR 讲法

**Situation：** 一个 SPU 下同时存在说明书、参数表、安装指南和售后政策，如果每次都把全部资料发送给大模型，会造成上下文膨胀、文档类型混淆和版本难以追溯。

**Task：** 将已审核 Chunk 组装成可复用的 SPU Markdown，并让售前咨询和生图平台按照问题需要渐进式获取知识。

**Action：** 我以 SPU 和 documentType 作为资料身份，从 reviewed Chunk snapshot 生成独立版本的 Markdown 和 Manifest；建立 SPU 文档索引，先向模型披露身份和可用文档类型，再按问题加载相关章节、表格事实和图片说明，最后补充来源版本和 Chunk 证据。Markdown 导出和 Embedding 保持独立，模型只能消费已审核、未冲突且具备发布资格的内容。

**Result：** 下游业务可以复用同一份 SPU 商品事实，售前问题优先加载参数或使用文档，生图问题优先加载视觉事实和稳定图片引用，避免每次把整个 SPU 资料包塞进上下文。当前应把具体 Token 节省、延迟变化和业务转化收益作为后续接入后的实测指标，不提前虚构。

## 14. 当前边界

- 本文描述的是后期 SPU 知识库输出和渐进式披露设计。
- 已确认的项目事实是：SPU Markdown 基于 reviewed Chunk 快照独立生成，并与 Embedding 链路分离。
- 渐进式披露的路由器、分层索引和下游大模型调用，需要在售前咨询、生图平台实际接入时继续实现和验收。
- 未有真实 Token、成本、延迟或转化率数据时，不应在简历中写具体提升比例。
- 不应把 SPU Markdown 描述成完整商品主数据、ERP、SKU 变体管理或自动合并所有来源文档的系统。
