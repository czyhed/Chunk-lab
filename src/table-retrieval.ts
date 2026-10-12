import { createHash, randomUUID } from "node:crypto";
import type { EmbedTexts } from "./embedding.js";

export type TableCell = {
  cellId: string;
  text: string;
  rowSpan: number;
  colSpan: number;
};

export type TableRowGroup = {
  rowGroupId: string;
  order: number;
  repeatedHeader: boolean;
  sourceSegmentIds: string[];
  rowStart: number;
  rowCount: number;
};

export type ReviewedTableModel = {
  type: "table";
  tableId: string;
  title?: string;
  columns: string[];
  rows: TableCell[][];
  rowGroups: TableRowGroup[];
};

export type TableSourceSegment = {
  id: string;
  page: number | null;
  bbox: number[] | null;
};

export type TableArtifact = {
  type: "table";
  tableId: string;
  title?: string;
  columns: string[];
  rows: TableCell[][];
  rowGroups: TableRowGroup[];
  sourceSegments: TableSourceSegment[];
};

export type TableSourceChunkRelation = {
  sourceChunkId: string;
  sourceChunkVersion: string;
  order: number;
  finalText: string;
};

export type TableVersionState = "staged" | "active" | "soft_deleted";

export type TableVersion = {
  logicalTableId: string;
  tableVersionId: string;
  artifact: TableArtifact;
  finalSummary: string;
  sourceChunks: TableSourceChunkRelation[];
  queryReady: boolean;
  queryReadyAt?: string;
  state: TableVersionState;
  createdAt: string;
  deletedAt?: string;
};

export type TableRetrievalBundle = {
  bundleId: string;
  tableVersionId: string;
  sourceChunkIds: string[];
  finalSummary: string;
  embeddingInputText: string;
  embeddingInputHash: string;
  embeddingProfileId: string;
  embeddingModel: string;
  vectorDimensions: number;
  vector: number[];
  vectorReady: boolean;
  createdAt: string;
  deletedAt?: string;
};

export type PublicTableRetrievalHit = {
  tableVersionId: string;
  logicalTableId: string;
  tableId: string;
  title?: string;
  finalSummary: string;
  sourceChunks: Array<Pick<TableSourceChunkRelation, "sourceChunkId" | "sourceChunkVersion" | "order" | "finalText">>;
  score: number;
};

export type TableRetrievalRepository = {
  saveVersion(version: TableVersion): Promise<void>;
  saveBundle(bundle: TableRetrievalBundle): Promise<void>;
  findActive(logicalTableId: string): Promise<TableVersion | null>;
  activateVersion(tableVersionId: string, previousTableVersionId?: string, at?: string): Promise<void>;
  getVersion(tableVersionId: string): Promise<TableVersion | null>;
  confirmQueryReady(tableVersionId: string, at: string): Promise<TableVersion>;
  search(queryVector: number[], profileId: string): Promise<PublicTableRetrievalHit[]>;
};

export type TableEmbeddingProfile = {
  id: string;
  model: string;
  dimensions: number;
};

export type CreateTableVersionInput = {
  logicalTableId: string;
  tableVersionId?: string;
  artifact: TableArtifact;
  finalSummary: string;
  sourceChunks?: TableSourceChunkRelation[];
  at?: string;
  rawTableHtml?: string;
  markdown?: string;
  renderedHtml?: string;
};

export type TableQueryValidation = {
  valid: boolean;
  reasons: string[];
};

export function tableArtifactFromReviewedModel(input: {
  reviewedModel: ReviewedTableModel;
  sourceSegments?: TableSourceSegment[];
}): TableArtifact {
  const model = structuredClone(input.reviewedModel);
  return {
    type: "table",
    tableId: model.tableId,
    ...(model.title?.trim() ? { title: model.title.trim() } : {}),
    columns: model.columns,
    rows: model.rows,
    rowGroups: model.rowGroups,
    sourceSegments: structuredClone(input.sourceSegments ?? []),
  };
}

export function validateTableQueryReadiness(artifact: TableArtifact): TableQueryValidation {
  const reasons: string[] = [];
  if (!artifact.columns.length) reasons.push("missing_columns");
  if (!artifact.rows.length) reasons.push("missing_rows");
  const names = artifact.columns.map((column) => column.trim());
  if (names.some((column) => !column)) reasons.push("empty_column_name");
  if (new Set(names).size !== names.length) reasons.push("duplicate_column_names");
  if (!artifact.rowGroups.length) reasons.push("missing_row_groups");

  const coveredRows = new Set<number>();
  for (const group of artifact.rowGroups) {
    if (
      !Number.isSafeInteger(group.rowStart) ||
      !Number.isSafeInteger(group.rowCount) ||
      group.rowStart < 0 ||
      group.rowCount <= 0 ||
      group.rowStart + group.rowCount > artifact.rows.length ||
      !group.sourceSegmentIds.length
    ) {
      reasons.push("missing_source_location");
      continue;
    }
    for (let row = group.rowStart; row < group.rowStart + group.rowCount; row += 1)
      coveredRows.add(row);
  }
  if (artifact.rows.some((_row, index) => !coveredRows.has(index)))
    reasons.push("missing_source_location");

  const occupied = new Set<string>();
  artifact.rows.forEach((row, rowIndex) => {
    let nextColumn = 0;
    for (const cell of row) {
      if (!cell.cellId.trim()) reasons.push("missing_cell_id");
      if (!Number.isSafeInteger(cell.rowSpan) || cell.rowSpan <= 0)
        reasons.push("invalid_row_span");
      if (!Number.isSafeInteger(cell.colSpan) || cell.colSpan <= 0)
        reasons.push("invalid_col_span");
      while (occupied.has(`${rowIndex}:${nextColumn}`)) nextColumn += 1;
      if (nextColumn + cell.colSpan > artifact.columns.length) {
        reasons.push("invalid_row_column_relationship");
        continue;
      }
      for (let rowOffset = 0; rowOffset < cell.rowSpan; rowOffset += 1) {
        for (let columnOffset = 0; columnOffset < cell.colSpan; columnOffset += 1) {
          const position = `${rowIndex + rowOffset}:${nextColumn + columnOffset}`;
          if (occupied.has(position)) reasons.push("invalid_row_column_relationship");
          occupied.add(position);
        }
      }
      nextColumn += cell.colSpan;
    }
  });
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function buildEmbeddingInputText(input: {
  artifact: Pick<TableArtifact, "title">;
  finalSummary: string;
  sourceChunks?: readonly TableSourceChunkRelation[];
}): string {
  const parts = [...(input.sourceChunks ?? [])]
    .filter((source) => source.finalText.trim())
    .sort((left, right) => left.order - right.order || left.sourceChunkId.localeCompare(right.sourceChunkId))
    .map((source, index) => `[关联文字 ${index + 1}]\n${source.finalText.trim()}`);
  if (input.finalSummary.trim()) parts.push(`[表格摘要]\n${input.finalSummary.trim()}`);
  if (input.artifact.title?.trim()) parts.push(`[表格身份]\n${input.artifact.title.trim()}`);
  return parts.join("\n\n");
}

export function embeddingInputHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function publicTableVersion(version: TableVersion): Omit<TableVersion, "artifact" | "sourceChunks"> & {
  tableId: string;
  title?: string;
  sourceChunkIds: string[];
} {
  return {
    logicalTableId: version.logicalTableId,
    tableVersionId: version.tableVersionId,
    finalSummary: version.finalSummary,
    queryReady: version.queryReady,
    ...(version.queryReadyAt ? { queryReadyAt: version.queryReadyAt } : {}),
    state: version.state,
    createdAt: version.createdAt,
    ...(version.deletedAt ? { deletedAt: version.deletedAt } : {}),
    tableId: version.artifact.tableId,
    ...(version.artifact.title ? { title: version.artifact.title } : {}),
    sourceChunkIds: version.sourceChunks
      .slice()
      .sort((left, right) => left.order - right.order || left.sourceChunkId.localeCompare(right.sourceChunkId))
      .map((source) => source.sourceChunkId),
  };
}

export function publicTableArtifact(version: TableVersion): Record<string, unknown> {
  return {
    tableVersionId: version.tableVersionId,
    logicalTableId: version.logicalTableId,
    tableId: version.artifact.tableId,
    ...(version.artifact.title ? { title: version.artifact.title } : {}),
    columns: structuredClone(version.artifact.columns),
    rows: structuredClone(version.artifact.rows),
    rowGroups: structuredClone(version.artifact.rowGroups),
    sourceSegments: structuredClone(version.artifact.sourceSegments),
    finalSummary: version.finalSummary,
    queryReady: version.queryReady,
  };
}

export class TableRetrievalService {
  constructor(
    private readonly options: {
      repository: TableRetrievalRepository;
      embedTexts: EmbedTexts;
      profile: TableEmbeddingProfile;
    },
  ) {}

  async createVersion(input: CreateTableVersionInput): Promise<{
    version: TableVersion;
    bundle: TableRetrievalBundle | null;
    validation: TableQueryValidation;
  }> {
    const at = input.at ?? new Date().toISOString();
    const logicalTableId = requiredId(input.logicalTableId, "logicalTableId");
    const tableVersionId = input.tableVersionId ?? randomUUID();
    const artifact: TableArtifact = {
      type: "table",
      tableId: input.artifact.tableId,
      ...(input.artifact.title?.trim() ? { title: input.artifact.title.trim() } : {}),
      columns: structuredClone(input.artifact.columns),
      rows: structuredClone(input.artifact.rows),
      rowGroups: structuredClone(input.artifact.rowGroups),
      sourceSegments: structuredClone(input.artifact.sourceSegments),
    };
    if (input.rawTableHtml || input.markdown || input.renderedHtml) {
      // These parser/rendering artifacts are intentionally accepted only as diagnostic input.
    }
    const validation = validateTableQueryReadiness(artifact);
    const sourceChunks = normalizeSourceChunks(input.sourceChunks ?? []);
    const version: TableVersion = {
      logicalTableId,
      tableVersionId,
      artifact,
      finalSummary: input.finalSummary.trim(),
      sourceChunks,
      queryReady: false,
      state: "staged",
      createdAt: at,
    };
    await this.options.repository.saveVersion(version);

    const embeddingInput = buildEmbeddingInputText({
      artifact,
      finalSummary: version.finalSummary,
      sourceChunks,
    });
    if (!embeddingInput) return { version, bundle: null, validation };
    const vectors = await this.options.embedTexts([embeddingInput]);
    const vector = vectors[0];
    if (!vector || vector.length !== this.options.profile.dimensions)
      throw new Error("Table Bundle 向量维度不匹配");
    const bundle: TableRetrievalBundle = {
      bundleId: randomUUID(),
      tableVersionId,
      sourceChunkIds: sourceChunks
        .slice()
        .sort((left, right) => left.order - right.order || left.sourceChunkId.localeCompare(right.sourceChunkId))
        .map((source) => source.sourceChunkId),
      finalSummary: version.finalSummary,
      embeddingInputText: embeddingInput,
      embeddingInputHash: embeddingInputHash(embeddingInput),
      embeddingProfileId: this.options.profile.id,
      embeddingModel: this.options.profile.model,
      vectorDimensions: vector.length,
      vector: [...vector],
      vectorReady: true,
      createdAt: at,
    };
    await this.options.repository.saveBundle(bundle);
    const previous = await this.options.repository.findActive?.(logicalTableId);
    await this.options.repository.activateVersion(tableVersionId, previous?.tableVersionId, at);
    version.state = "active";
    return { version, bundle, validation };
  }

  async confirmQueryReady(tableVersionId: string, at = new Date().toISOString()): Promise<TableVersion> {
    const version = await this.options.repository.getVersion(tableVersionId);
    if (!version) throw new Error("Table Version 不存在");
    const validation = validateTableQueryReadiness(version.artifact);
    if (!validation.valid) throw new Error(`Table Version 不满足 query_ready: ${validation.reasons.join(",")}`);
    return this.options.repository.confirmQueryReady(tableVersionId, at);
  }

  async search(query: string): Promise<PublicTableRetrievalHit[]> {
    const text = query.trim();
    if (!text) return [];
    const vectors = await this.options.embedTexts([text]);
    const vector = vectors[0];
    if (!vector || vector.length !== this.options.profile.dimensions)
      throw new Error("查询向量维度不匹配");
    return this.options.repository.search(vector, this.options.profile.id);
  }
}

export class MemoryTableRetrievalRepository implements TableRetrievalRepository {
  readonly events: string[] = [];
  readonly versions = new Map<string, TableVersion>();
  readonly bundles = new Map<string, TableRetrievalBundle>();

  async saveVersion(version: TableVersion): Promise<void> {
    if (this.versions.has(version.tableVersionId)) throw new Error("Table Version ID 不可变且不能重复");
    this.events.push(`save-version:${version.tableVersionId}`);
    this.versions.set(version.tableVersionId, structuredClone(version));
  }

  async saveBundle(bundle: TableRetrievalBundle): Promise<void> {
    this.events.push(`save-bundle:${bundle.tableVersionId}`);
    this.bundles.set(bundle.tableVersionId, structuredClone(bundle));
  }

  async findActive(logicalTableId: string): Promise<TableVersion | null> {
    return [...this.versions.values()].find((version) =>
      version.logicalTableId === logicalTableId && version.state === "active"
    ) ?? null;
  }

  async activateVersion(tableVersionId: string, previousTableVersionId?: string, at = new Date().toISOString()): Promise<void> {
    const version = this.versions.get(tableVersionId);
    if (!version) throw new Error("Table Version 不存在");
    if (previousTableVersionId) {
      const previous = this.versions.get(previousTableVersionId);
      if (previous) {
        previous.state = "soft_deleted";
        previous.deletedAt = at;
        const previousBundle = this.bundles.get(previous.tableVersionId);
        if (previousBundle) previousBundle.deletedAt = at;
        this.events.push(`soft-delete:${previous.tableVersionId}`);
      }
    }
    version.state = "active";
    this.events.push(`activate:${tableVersionId}`);
  }

  async getVersion(tableVersionId: string): Promise<TableVersion | null> {
    const version = this.versions.get(tableVersionId);
    return version ? structuredClone(version) : null;
  }

  async confirmQueryReady(tableVersionId: string, at: string): Promise<TableVersion> {
    const version = this.versions.get(tableVersionId);
    if (!version) throw new Error("Table Version 不存在");
    version.queryReady = true;
    version.queryReadyAt = at;
    return structuredClone(version);
  }

  async search(queryVector: number[], profileId: string): Promise<PublicTableRetrievalHit[]> {
    const hits: PublicTableRetrievalHit[] = [];
    for (const bundle of this.bundles.values()) {
      const version = this.versions.get(bundle.tableVersionId);
      if (!version || version.state !== "active" || bundle.deletedAt || bundle.embeddingProfileId !== profileId) continue;
      hits.push({
        tableVersionId: version.tableVersionId,
        logicalTableId: version.logicalTableId,
        tableId: version.artifact.tableId,
        ...(version.artifact.title ? { title: version.artifact.title } : {}),
        finalSummary: version.finalSummary,
        sourceChunks: structuredClone(version.sourceChunks),
        score: cosineSimilarity(queryVector, bundle.vector),
      });
    }
    return hits.sort((left, right) => right.score - left.score || left.tableVersionId.localeCompare(right.tableVersionId));
  }
}

function normalizeSourceChunks(input: TableSourceChunkRelation[]): TableSourceChunkRelation[] {
  const seen = new Set<string>();
  return input.map((source) => {
    const sourceChunkId = requiredId(source.sourceChunkId, "sourceChunkId");
    if (seen.has(sourceChunkId)) throw new Error("sourceChunkId 不能重复");
    seen.add(sourceChunkId);
    if (!Number.isSafeInteger(source.order) || source.order < 0) throw new Error("source chunk order 无效");
    if (typeof source.sourceChunkVersion !== "string" || !source.sourceChunkVersion.trim()) throw new Error("sourceChunkVersion 不能为空");
    return { sourceChunkId, sourceChunkVersion: source.sourceChunkVersion.trim(), order: source.order, finalText: source.finalText.trim() };
  });
}

function requiredId(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim() || !/^[A-Za-z0-9_:-]+$/.test(value.trim())) throw new Error(`${name} 无效`);
  return value.trim();
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) return -1;
  const leftNorm = Math.hypot(...left) || 1;
  const rightNorm = Math.hypot(...right) || 1;
  return left.reduce((sum, value, index) => sum + value * right[index], 0) / (leftNorm * rightNorm);
}
