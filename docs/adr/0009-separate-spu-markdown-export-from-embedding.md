# Separate SPU Markdown Export from Embedding

## Context

Chunk Lab needs two downstream products from reviewed Chunks:

1. human-readable SPU product-material Markdown stored in MinIO;
2. embedding records stored in the vector database.

The same SPU may contain multiple source documents, and one source document may cover multiple SPUs at Chunk scope. Treating the generated Markdown as the vector input would lose source provenance, structured table identity, review state, and embedding eligibility semantics.

## Decision

Generate SPU Markdown and vector records as independent downstream jobs from the same reviewed Chunk snapshot.

- Markdown uses reviewed `finalText` and structured table/image representations.
- Embedding uses server-authoritative `embeddingText`.
- Markdown is a derived reading representation and never becomes the source of truth.
- Each Markdown export is immutable and stored in a versioned MinIO object path.
- The two jobs have separate status, retry, staleness, and current-version handling.
- A multi-SPU source document produces one independently tracked Markdown result per confirmed SPU; `common` Chunk scope and source provenance are retained in each Manifest.
- Operators cannot select arbitrary Chunk subsets. Exclusions are allowed only from completed Chunks that fail document-publish eligibility; pending, reviewing, failed, unassigned, or conflicted Chunks block Markdown export.

## Consequences

### Positive

- Markdown formatting changes do not require re-embedding.
- Embedding model changes do not rewrite product documents.
- Source segments and structured artifacts remain auditable.
- Eligibility-based exclusions can be represented explicitly through Manifest exclusions without allowing arbitrary partial selection.

### Trade-offs

- The system stores two downstream representations and must keep their source revision metadata aligned.
- Future Wiki synchronization needs an additional mapping layer rather than directly publishing vectors or raw chunks.
- Export orchestration and UI expose two independent task states.
