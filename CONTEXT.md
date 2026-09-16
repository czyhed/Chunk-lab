# Document Chunking

This context describes how source documents become reviewable, human-corrected chunks for later RAG use.

## Language

**Parse Batch**:
A group of Source Documents submitted together when the Data Annotator explicitly starts parsing. Each document progresses independently within the batch.
_Avoid_: Upload batch, task

**Source Document**:
One uploaded file whose content and layout are the immutable reference for parsing, chunking, and correction.
_Avoid_: Material, raw data

**Parsed Document**:
The per-document structured result derived from a Source Document, retaining its readable content, document structure, and source locations.
_Avoid_: Cleaned document, MinerU result

**Parse Configuration**:
The Data Annotator's selected recognition and quality settings used to derive a Parsed Document.
_Avoid_: Cleaning options, MinerU parameters

**Content Block**:
An ordered, source-located unit of a Parsed Document. A table or image remains one Content Block even when its representation contains several parts.
_Avoid_: Paragraph, element

**Content Group**:
One or more Content Blocks that belong together because of document structure or meaning, such as an image with its caption, a table with its notes, or a warning with its body. A Content Group may be protected from ordinary text splitting.
_Avoid_: Block collection, section

**Product Identity**:
The product name, brand, model, variant, or applicable version that determines which product a piece of document content describes.
_Avoid_: Product metadata, document title

**Model Enrichment**:
Model-generated content, such as an image or table summary, that remains linked to its source Content Block and records the generating model and version.
_Avoid_: Extracted text, source content

**Chunk Draft**:
The current per-document set of chunks produced from a Parsed Document by a Chunking Configuration. It may contain Chunk Revisions without replacing the Parsed Document.
_Avoid_: Chunk result, final chunks

**Chunking Strategy**:
A named method for deriving a Chunk Draft from one Parsed Document.
_Avoid_: Text splitter type, cutting method

**Structure-Aware Chunking**:
A Chunking Strategy that uses Product Identity, headings, reading order, and Content Groups before applying a token budget to eligible text. Protected Content Groups are not arbitrarily crossed or truncated.
_Avoid_: Layout splitter, block splitter

**Protected Content Group**:
A Content Group whose internal structure ordinary text strategies must preserve, such as a table, image with caption, or warning notice. An oversized protected group is split only by a type-specific rule or retained whole with a Quality Flag.
_Avoid_: Atomic block, unbreakable block

**Chunking Configuration**:
A required selection of one Chunking Strategy, its parameters, and its non-text content policies. A batch-wide selection may be overridden for an individual Source Document.
_Avoid_: Splitter settings, global parameters

**Configuration Draft**:
The Data Annotator's unconfirmed Chunking Configuration changes. It does not alter the current Chunk Draft until explicitly applied.
_Avoid_: Live configuration, active parameters

**Chunk Preview**:
A regenerable set of proposed chunks produced after the Data Annotator applies a Configuration Draft. It becomes a Chunk Draft only after the Data Annotator confirms the proposed boundaries.
_Avoid_: Chunk Draft, live preview

**Source Segment**:
The exact part of a Content Block referenced by a Chunk, retaining its page region and text range when available. A Chunk may reference multiple Source Segments across blocks or pages.
_Avoid_: Source block ID, highlight box

**Chunk Quality Metric**:
A descriptive count or distribution about a Chunk Preview, such as token size, overlap, cross-page coverage, or missing Product Identity. It informs review but does not declare a configuration correct automatically.
_Avoid_: Chunk score, quality percentage

**Semantic Signal**:
A review aid showing the embedding distance between adjacent sentence windows and the breakpoint candidates selected by the current semantic threshold. It explains a semantic Chunking Strategy but does not replace human judgment.
_Avoid_: Confidence score, model accuracy

**Context Candidate**:
A Chunk that the platform recommends for Context Enhancement because its meaning may depend on document information outside the Chunk. The Data Annotator decides whether to accept the recommendation.
_Avoid_: Required context, low-quality Chunk

**Context Enhancement**:
Optional background text generated for a selected Chunk from its source document and stored separately from the Chunk's own content. It is combined with the Chunk only for downstream embedding and may be reviewed or corrected by the Data Annotator.
_Avoid_: Chunk summary, text correction, contextualized Chunk

**Context Review State**:
The lifecycle of a selected Chunk's Context Enhancement: not generated, generating, awaiting review, confirmed, human-modified, failed, or stale. Only confirmed or human-modified context is eligible for downstream embedding.
_Avoid_: Generation status, Chunk status

**Data Annotator**:
The sole V1 operator who uploads Source Documents, starts parsing, selects a Chunking Strategy, reviews chunks, and corrects them.
_Avoid_: Uploader, chunk worker, reviewer

**Text Correction**:
A human-authored change to text in a Chunk Draft that remains traceable to the unchanged Parsed Document and Source Document. It is one kind of Chunk Revision.
_Avoid_: Data cleaning, source edit

**Chunk Revision**:
A human-authored split, merge, exclusion, reordering, or Text Correction applied to a Chunk Draft after its Chunking Configuration is confirmed.
_Avoid_: Manual cleanup, annotation

**Quality Flag**:
A visible indication that a Parsed Document, Content Block, or Chunk needs human attention because parsing or enrichment may be incomplete or unreliable.
_Avoid_: Error, review status, warning only

**Temporary Workspace**:
A short-lived work area containing the files, parser results, model enrichments, Chunk Drafts, and revisions for one active Parse Batch before automatic expiry.
_Avoid_: Document library, repository, archive

**Content Fingerprint**:
The SHA-256 digest of a Source Document's original file bytes. Documents with the same Content Fingerprint represent the same source content for deduplication and processing exclusivity.
_Avoid_: File name, upload ID, parse job ID

**Document Processing Lease**:
A temporary exclusive right for one authenticated session to process a Source Document in Chunk Lab. It expires through lease timeout when the session disappears and does not contain the document's persisted review state.
_Avoid_: Permanent file lock, ownership, edit permission

**Lease Holder**:
The authenticated user and browser session currently holding a Document Processing Lease for a Source Document.
_Avoid_: Uploader, document owner

**Review Progress**:
The persisted human-processing state of a Chunk Draft, including completed Chunk identifiers and the resume cursor. Review Progress survives lease release and allows later sessions to continue the same document.
_Avoid_: Redis lock state, export state

**Completed Chunk**:
A Chunk that the Data Annotator has explicitly marked as human-processed. Saving a Draft does not make a Chunk completed; editing a completed Chunk removes its completed state until it is marked again.
_Avoid_: Saved Chunk, exported Chunk

**Image Chunk**:
An independently reviewable chunk containing an image asset reference, source location, nearby context, and optional Model Enrichment.
_Avoid_: Image embedding, image attachment

**Table Chunk**:
An independently reviewable chunk containing a table's structure, source location, and optional Model Enrichment. An oversized table may comprise ordered row groups that retain one shared table identity.
_Avoid_: Table text, spreadsheet chunk

**Table Artifact**:
The authoritative structured representation of a reviewed table. It preserves columns, rows, cell relationships, and source provenance; Markdown and rendered HTML are derived views, not the table's source of truth.
_Avoid_: Table summary, table HTML

**Table Version**:
An immutable reviewed state of a Table Artifact. A changed table creates a new version; retrieval references a specific version rather than silently changing historical content.
_Avoid_: Current table, mutable table record

**Table Retrieval Bundle**:
The ordinary-retrieval representation for one Table Version. It combines its approved linked text and one final reviewed table summary into one searchable semantic unit, while leaving the full table in the Table Artifact.
_Avoid_: Table body, duplicate table copy

**Ordinary Retrieval**:
Vector retrieval over text or Table Retrieval Bundles to discover relevant content. A hit may return linked text and offer the associated table for display.
_Avoid_: Structured query, SQL retrieval

**Deep Retrieval**:
Structured retrieval over a query-ready Table Version to find matching rows or columns and return their table and source provenance.
_Avoid_: Vector lookup, summary retrieval

**Export Package**:
A downloadable snapshot of one Parse Batch containing its document Chunk Drafts, provenance, configurations, revisions, and quality flags.
_Avoid_: Published dataset, vector index

**SPU**:
The product-level identity used to group related product materials. One SPU may have multiple source documents and multiple material documents; it is not the same as a specific SKU variant.
_Avoid_: SKU, source document

**SPU Material Document**:
A derived, human-readable representation generated for one SPU from one Source Document Version and one confirmed document type. It is stored separately from Chunks and vector records.
_Avoid_: Export Package, vector index

**Material Document Type**:
The confirmed classification of an SPU Material Document: `manual`, `specification`, `installation`, `after_sales`, `mixed`, or `other`.
_Avoid_: File extension, inferred title

**Document Publish Eligibility**:
The independent decision about whether a completed Chunk may appear in an SPU Material Document. It is separate from Embedding Eligibility.
_Avoid_: Embedding eligibility, review completion

**SPU Material Export**:
An immutable versioned Markdown and Manifest pair generated from the complete reviewed state of one Source Document for one confirmed SPU. Operators cannot select an arbitrary subset of Chunks for an export.
_Avoid_: Chunk merge, published Wiki page
