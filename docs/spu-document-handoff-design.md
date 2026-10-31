# SPU 商品资料文档交接设计

## 1. 目的

本文用于交接给负责使用商品资料的同事，说明切分后的 Markdown 如何识别 SPU、如何选择正确文档，以及多 SPU 文档和版本更新时的使用规则。

## 2. 先说结论

### 2.1 导出的 Markdown 有 SPU 标识

系统生成的每个 SPU Markdown 文件，文档顶部都会写入：

```md
# 商品资料

- SPU: SPU-10001
- 文档类型: manual
- 来源文档: a1-manual.pdf
- 来源版本: source-v1
- Review Revision: 4
- 导出版本: v1
```

因此，接收方可以直接读取 Markdown 顶部的 `SPU:` 字段确认归属。

### 2.2 原始 Markdown 不会自动带 SPU

用户上传的原始 Markdown、解析过程中的 Markdown 源码和普通 Chunk 正文，不会被系统逐段改写为“SPU: xxx”。SPU 属于文档和 Chunk 的元数据，最终在 **SPU 导出 Markdown 的文档头部**体现。

### 2.3 一个 Source Document 可能生成多个 SPU Markdown

当一份 Source Document 绑定多个 SPU 时，系统为每个目标 SPU 单独生成一份 Markdown。不能把同一份文件同时当作多个 SPU 的独立资料，必须按文件头的 `SPU:` 和文件名区分。

## 3. 识别一个 SPU 文档

按以下优先级确认身份：

1. Markdown 文档头部的 `SPU:`；
2. 文件名中的 SPU 前缀；
3. 配套 Manifest 的 `targetSpuId`；
4. 对象存储路径中的 `spu/<SPU ID>/`。

示例文件名：

```text
SPU-MOUSE-7K2M9Q4D_manual_V3-Pro-a1b2c3d4_v2.md
```

文件名结构：

```text
<SPU ID>_<documentType>_<source-name>_<exportVersion>.md
```

文件名用于快速筛选，最终以 Markdown 头部和 Manifest 为准。

## 4. 普通 Chunk 与例外 Chunk

### 4.1 单 SPU 文档

单 SPU 文档确认资料归属后，普通 Chunk 默认继承文档级 SPU。使用方不需要逐个 Chunk 设置 SPU。

### 4.2 多 SPU 文档

多 SPU 文档必须按 Chunk 范围生成各自的 SPU Markdown：

| Chunk 范围 | 含义 | 输出行为 |
|---|---|---|
| `assigned` | 指定一个或多个 SPU | 只进入被指定的 SPU 文档 |
| `common` | 文档声明范围内的公共资料 | 可复制进入目标 SPU 文档；Manifest 保留 `scope=common` |
| `unassigned` | 尚未确认归属 | 阻断相关 SPU 导出 |
| `conflicted` | 归属存在冲突 | 阻断冲突目标 SPU 导出 |

因此，某个 SPU 文档缺少另一 SPU 的专属内容是正常的，不应手工复制补齐。

## 5. 同事使用流程

### 5.1 按 SPU 建立资料入口

建议以 `SPU ID` 作为资料库、检索集合或业务目录的一级键：

```text
SPU-MOUSE-7K2M9Q4D/
  manual/
    SPU-MOUSE-7K2M9Q4D_manual_..._v2.md
  specification/
    SPU-MOUSE-7K2M9Q4D_specification_..._v1.md
```

### 5.2 导入前检查

每次导入或替换文档前检查：

- Markdown 头部存在 `SPU:`；
- `SPU:` 与文件名中的 SPU ID 一致；
- 文档类型符合使用场景，例如 `manual`、`specification`；
- 导出状态为 `complete` 或 `complete_with_exclusions`；
- 若有 Manifest，Manifest 的 `targetSpuId` 与 Markdown 的 `SPU:` 一致；
- 不使用 `blocked`、`failed` 或已标记 `stale` 的版本。

### 5.3 版本替换

同一 SPU 的新导出会产生新的 `exportVersion`，例如 `v1`、`v2`。使用方应：

1. 使用系统当前指向的版本；
2. 发现旧版本为 `stale` 时停止继续使用旧版本；
3. 不通过 Markdown 内容自行合并不同版本；
4. 保留版本号，便于检索结果和业务问题追溯。

## 6. 不应做的事情

- 不要只根据原始文件名判断 SPU；
- 不要把多 SPU 导出文件合并成一份再使用；
- 不要把 `common` 内容误认为某一个 SPU 的专属内容；
- 不要使用 `unassigned` 或 `conflicted` 文档作为正式资料；
- 不要从 Markdown 反向重建 Chunk、来源位置或向量记录；
- 不要修改 Markdown 顶部的 SPU、来源版本和导出版本字段。

## 7. 交接时的最小信息

交接一份资料时，至少同时提供：

```text
SPU ID
文档类型
Markdown 文件
导出版本
来源文档版本
导出状态
Manifest（如需要追溯 Chunk 和来源）
```

推荐交接说明：

```text
SPU：SPU-MOUSE-7K2M9Q4D
资料类型：manual
当前版本：v2
来源版本：source-v1
状态：complete_with_exclusions
使用文件：SPU-MOUSE-7K2M9Q4D_manual_..._v2.md
```

## 8. 与向量检索的关系

Markdown 是面向阅读、归档和资料交接的派生文件；向量检索使用独立的 `embeddingText` 和数据库记录。二者共享已审核 Chunk 快照，但不能用 Markdown 文件替代向量元数据，也不能因为 Markdown 可读就跳过 SPU 过滤。

检索系统必须先确定目标 `SPU ID`，再在该 SPU 的向量范围内检索；公共 Chunk 可按系统记录同时服务多个目标 SPU。

## 9. 相关实现依据

- Markdown 顶部元数据：`src/spu-material-export.ts` 的 `buildMarkdown()`；
- 多 SPU 分发：`createSpuMaterialFanout()`；
- SPU 文件名和对象路径：`spuMaterialFileName()`、`spuMaterialObjectKeys()`；
- 产品规则：`docs/spu-product-material-export-prd-v1.md`。

