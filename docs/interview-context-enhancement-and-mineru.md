# RAG Chunk 上下文增强与 MinerU 多模式解析利用

## 项目概述

该项目面向商品手册、说明书和结构化业务文档，目标是将 MinerU 解析结果转换为可审核、可追溯、适合检索的 Chunk。核心难点不是简单切分文本，而是解决 Chunk 离开原文后出现的语义缺失，例如商品型号不明确、章节标题丢失、代词指向不清、图片只有图注而没有可检索语义。

项目采用如下处理链路：

```text
源文档
  -> MinerU Pipeline / OCR / VLM 解析
  -> Parsed Document / Content Blocks
  -> 应用生成 Chunk Draft
  -> 选择需要增强的 Chunk
  -> 构造 Context Package
  -> Context LLM 生成 2-4 句背景
  -> 人工确认或修改
  -> Context + finalText 用于 Embedding
```

这套设计强调三个边界：解析结果不等于最终 Chunk，模型生成内容不自动覆盖人工审核文本，发送给 Context LLM 的内容必须可解释其来源。

## 项目背景与挑战

MinerU 可以提取正文、表格、图片位置、图注和页面结构，但一个被独立检索的 Chunk 常常缺少文档级背景。例如：

```text
长按此按钮 3 秒即可启动清洗程序。
```

这句话在原文中可以依赖标题、商品名称和相邻说明；进入向量库后却无法回答“哪个商品”“哪个按钮”“什么清洗程序”。另一方面，直接把整个文档发送给 LLM 会增加成本、重复信息和错误引用风险。

项目需要同时解决：

- 不同 MinerU 模式提供的信息丰富度不同，不能假设 OCR、Pipeline 或 VLM 都有相同字段。
- MinerU 的 Content Block 不是业务 Chunk，不能把解析块 ID 当成最终 Chunk ID。
- 图片块可能只有路径或图注，不能假设 MinerU 一定生成语义摘要。
- `productIdentity`、父章节等字段可能缺失，必须保持可选语义。
- Context LLM 既要看到足够背景，又不能引用已排除或下游资格无效的相邻 Chunk。
- 原始 Parsed Document 文本和人工审核后的 `finalText` 可能不同，需要同时保留来源与审核结果。

## 目标与职责

我的任务是设计一套可审计的 Chunk 上下文增强合同：明确每个请求字段来自哪里、哪些内容可以发送、短文档和长文档如何控制范围、图片 VLM 与 Context LLM 如何分工，以及生成结果如何进入人工审核和 Embedding。

成功标准包括：

- 每个 Context 请求都能解释其数据来源。
- MinerU、应用 Chunking、图片 VLM 和 Context LLM 的职责不混淆。
- 被排除或不具备下游资格的直接相邻 Chunk 不参与 Context 参考。
- 模型结果先审核，不能直接污染 `finalText` 或向量库。
- 原始文本、人工修订文本和模型增强文本分别保存。

## 数据分层设计

### MinerU 原始结果

MinerU 返回页面内容、类型、文本、表格内容、图片路径、图注、坐标和可能存在的结构字段。应用对这些字段做标准化，而不是直接把 MinerU 输出作为 Chunk。

图片块的初始文本优先级为：

```text
image_caption
  -> text
  -> 空字符串
```

因此“MinerU 识别出图片块”不等于“MinerU 已生成可靠图片摘要”。

### Parsed Document / Content Block

应用将 MinerU 内容列表标准化为 Parsed Blocks。标准化阶段会生成应用自己的 Content Block ID，例如：

```text
b-1
b-2
b-3
```

这些 ID 用于来源定位，不是最终业务 Chunk ID。

### Chunk Draft

应用根据策略将一个或多个 Parsed Blocks 组合或切分成 Chunk，并生成自己的 Chunk ID，例如：

```text
flow-1-1
b-7-2
image-group-3-1
```

Chunk 通过 `sourceBlockIds` 和 `sourceSegments` 保持与 Parsed Document 的可追溯关系。

### Context Package

Context Package 不是 MinerU 返回对象，而是应用在请求 Context LLM 前动态构造的文本包。它包含当前 Chunk 文本、来源块、父章节、商品身份、相邻 Chunk 和取材范围。

## Context 请求字段来源对比

| 字段 | 含义 | 直接来源 | 应用处理 | 是否保证存在 |
|---|---|---|---|---|
| `finalText` | 当前 Chunk 审核后的最终文本 | 初始来自 Parsed Block 文本 | 可被人工修订；图片摘要确认后可成为最终文本 | 是，但图片初始值可能为空 |
| `productIdentity` | 商品、型号或适用版本 | 可选读取 MinerU 的 `productIdentity` / `product_identity` | Chunking 时从来源块复制 | 否 |
| `parentSectionId` | 所属父章节的 Content Block ID | 可选读取 MinerU 的 `parentId` / `parent_id` | Chunking 时从来源块复制 | 否 |
| `sourceText` | 当前 Chunk 对应的原始来源文本 | Parsed Document 中的 `searchText` | 根据 `sourceBlockIds` 回查并拼接 | 通常有，图片可能较弱 |
| `referenceText` | 给 Context LLM 的参考材料 | Parsed Blocks 与相邻 Chunk | 按短/长文档规则动态选择和拼接 | 是，可为空字符串 |
| `actualScope` | 本次参考范围的解释标签 | 无直接上游字段 | 应用按实际选中内容生成 | 是 |

其中，`actualScope` 可能类似：

```json
[
  "当前来源 b-18",
  "同组 b-19",
  "父标题 b-12",
  "相邻 Chunk flow-4-2",
  "完整 Parsed Document"
]
```

它不是文档正文，而是让请求和后续审核可解释的范围说明。

## MinerU 不同模式的信息利用

| 模式 | 常见可用信息 | 图片语义能力 | `productIdentity` 保证 | 在项目中的使用方式 |
|---|---|---|---|---|
| OCR | 识别文本、页码、坐标，能力取决于识别结果 | 可能识别图片内文字，但通常不理解图片整体含义 | 不保证 | 作为 Parsed Block 初始文本和来源定位 |
| Pipeline | 正文、表格、图片路径、图注、版面顺序等结构信息 | 通常提供位置和图注，不保证图片摘要 | 不保证 | 构造 Content Blocks、分组、父子结构和 Chunk 来源 |
| MinerU VLM | 可能提供更丰富的文本或图像描述，取决于实际返回合同 | 通常强于纯 OCR，但不能假定字段稳定 | 仍不保证 | 仍按统一适配器读取 `image_caption` 或 `text`，不直接视为人工确认摘要 |
| 应用图片 VLM | 真实图片、已有商品身份、章节、图注和附近文本 | 专门生成可核验图片摘要 | 不负责回填商品身份 | 摘要进入待审核状态，确认后作为图片 Chunk `finalText` |
| Context LLM | Chunk 文本和应用构造的 Context Package | 不直接查看图片，除非图片已转为审核摘要 | 只消费已有字段 | 生成 2-4 句检索背景，确认后参与 Embedding |

关键结论是：代码支持读取 `productIdentity`，不代表 MinerU 标准结果一定提供。OCR、Pipeline 和 MinerU VLM 都可能缺失该字段；非商品文档本身也不应强行拥有商品身份。

## 图片处理与 Chunk ID 归属

MinerU 不负责生成最终业务 Chunk ID，图片 VLM 也不会返回新的 Chunk ID。

完整关系如下：

```text
MinerU 图片记录
  -> 应用生成 Content Block ID
  -> Chunking 生成图片 Chunk ID
  -> 服务端根据 Chunk ID 发起图片 VLM 请求
  -> VLM 只返回摘要文本
  -> 服务端把摘要写回原图片 Chunk
```

图片 VLM 的输入包括：

```json
{
  "productIdentity": "已有商品身份或 null",
  "section": "已有父章节或 null",
  "caption": "MinerU 图注或 null",
  "nearbyText": "附近 Parsed Blocks 文本",
  "image": "受控图片输入"
}
```

VLM 不返回：

```json
{
  "newChunkId": "..."
}
```

Chunk ID 始终由应用维护，模型结果只能挂回已有 Chunk。

## 短文档与长文档 Context 策略

应用先拼接全部 `documentBlocks.searchText`，使用 JavaScript 字符长度判断：

```text
documentText.length <= 12,000
```

12,000 是模式切换阈值，不是最终 HTTP 请求体的严格上限。

| 场景 | 文档块参考范围 | 相邻 Chunk | 特点 |
|---|---|---|---|
| 短文档 | 全部 `safeReferenceBlocks` | 追加前后合格 Chunk 的 `finalText` | 背景完整，但可能出现文本重复 |
| 长文档 | 当前来源块、同 Content Group 块、父标题 | 追加前后合格 Chunk 的 `finalText` | 控制请求规模，保留局部结构 |

### `safeReferenceBlocks` 的准确含义

代码中的“安全参考块”并不是全局安全审查，其准确含义是：

```text
全部 documentBlocks
减去
不合格的直接相邻 Chunk 所引用的 Content Blocks
```

伪代码为：

```ts
const skippedSourceBlockIds = new Set(
  ineligibleAdjacentChunks.flatMap(chunk => chunk.sourceBlockIds)
);

const safeReferenceBlocks = documentBlocks.filter(
  block => !skippedSourceBlockIds.has(block.contentBlockId)
);
```

因此更准确的名称应当是“未被不合格相邻 Chunk 引用的文档块”。当前实现不会全局遍历所有远处的已排除 Chunk，这是一项已识别的改进空间。

### 相邻 Chunk 的定义

相邻不是向量检索结果，也不是语义相似 Chunk，而是当前 Chunk Draft 顺序中的：

```text
index - 1：前一个 Chunk
index + 1：后一个 Chunk
```

中间位置最多有两个相邻 Chunk，文档首尾最多一个。相邻 Chunk 只有满足以下条件才加入：

```text
excluded = false
embeddingEligible = true
embeddingExclusionReasons 为空
```

## 为什么短文档还要追加相邻 Chunk finalText

短文档参考块中通常已经包含相邻 Chunk 的来源文本，但来源文本和 `finalText` 属于不同数据层：

| 数据 | 代表什么 | 可能发生的变化 |
|---|---|---|
| `searchText` | Parsed Document 原始解析文本 | 保留 OCR/解析结果 |
| `finalText` | 当前 Chunk Draft 审核后的文本 | 人工纠错、合并拆分、表格编辑、图片摘要确认 |

例如：

```text
searchText: A1咖啡机青洗模式
finalText:  A1 咖啡机清洗模式
```

或者图片：

```text
searchText: 图 3
finalText:  图中展示 A1 咖啡机水箱的拆卸方向。
```

追加 `finalText` 可以让 Context LLM 同时看到原始来源和审核结果。但当普通文本未经修改时，两者可能完全相同，当前实现没有跨层去重，因此会产生冗余。

合理的后续优化是计算相邻 Chunk 的来源块拼接文本，仅在 `finalText` 与来源文本不同、或包含图片摘要/表格修订时追加。

## 完整请求示例

当前 Chunk：

```json
{
  "id": "flow-4-1",
  "finalText": "长按此按钮 3 秒即可启动清洗程序。",
  "productIdentity": "A1 Pro 智能咖啡机",
  "parentSectionId": "b-12",
  "sourceBlockIds": ["b-18"],
  "embeddingEligible": true
}
```

构造后的 Context 用户消息：

```json
{
  "productIdentity": "A1 Pro 智能咖啡机",
  "parentSectionId": "b-12",
  "actualScope": [
    "当前来源 b-18",
    "父标题 b-12",
    "相邻 Chunk flow-4-2",
    "完整 Parsed Document"
  ],
  "sourceText": "[b-18]\n长按此按钮 3 秒即可启动清洗程序。",
  "referenceText": "[b-12]\n清洗与维护\n\n[b-18]\n长按此按钮 3 秒即可启动清洗程序。\n\n[相邻 Chunk flow-4-2]\n清洗完成后，请等待设备冷却。",
  "chunkText": "长按此按钮 3 秒即可启动清洗程序。"
}
```

模型可能返回：

```text
该操作适用于 A1 Pro 智能咖啡机的清洗与维护功能。
用户需要长按清洗按钮 3 秒启动日常清洗程序。
清洗完成后应等待设备冷却。
```

模型输出首先进入待审核状态。只有人工确认或人工修改后，Embedding 文本才变为：

```text
该操作适用于 A1 Pro 智能咖啡机的清洗与维护功能。
用户需要长按清洗按钮 3 秒启动日常清洗程序。
清洗完成后应等待设备冷却。

长按此按钮 3 秒即可启动清洗程序。
```

## 实施结果

最终形成了一套边界清晰的上下文增强链路：

- MinerU 负责解析和来源结构，不被误当作最终 Chunk 系统。
- 应用统一生成 Content Block ID、Chunk ID 和可追溯关系。
- 图片 VLM 专注生成图片事实摘要，不创建 Chunk 或修改商品身份。
- Context LLM 消费应用构造的结构化文本包，不直接访问原文件、图片二进制或向量。
- 模型结果必须经过人工确认，才能与 `finalText` 组合进入 Embedding。
- 短长文档有明确范围策略，相邻 Chunk 有明确资格门槛。
- 已识别短文档重复发送和“安全参考块”命名过宽的问题，为后续优化留下可验证方向。

## 面试表达要点

该项目最有价值的部分不是调用了 LLM，而是把多个不稳定数据源变成了可解释合同：上游 MinerU 字段允许缺失，中间 Chunk 保持来源追踪，下游模型只能在受控范围内生成文本，最终结果仍由人工确认。

面试时可以重点说明：

1. 为什么不能直接把 MinerU block 当成 Chunk。
2. 为什么 `productIdentity` 必须是可选字段。
3. 为什么图片 VLM 和 Context LLM 要拆成两条链路。
4. 为什么相邻 Chunk 必须经过下游资格过滤。
5. 为什么 `searchText` 与 `finalText` 都有价值，以及如何进一步去重。
6. 如何通过 `sourceBlockIds`、`sourceSegments` 和 `actualScope` 实现可追溯与可审计。

## 当前局限与下一步

- 对短文档的资格过滤只针对直接相邻 Chunk，不是全局 Content Block 资格投影。
- `searchText` 与相邻 Chunk `finalText` 可能重复，需要内容级去重。
- `productIdentity` 当前依赖上游可选字段或人工流程，尚未形成独立、可审核的商品身份抽取合同。
- 12,000 字符只是模式阈值，缺少严格 Token 预算和最终请求体上限。
- MinerU VLM 返回的图片描述与应用图片 VLM 摘要需要更明确的 provenance 标识，避免把解析文本误认为人工确认摘要。

这些限制没有通过隐藏或猜测处理，而是保留为显式合同和可测试的改进项。
