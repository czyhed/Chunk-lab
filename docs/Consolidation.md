# V2 Consolidation

## Purpose

This document consolidates work that is already complete and verified before V2 implementation. It is a baseline, not a list of V2 features.

## Confirmed Product Work

- The V2 PRD is confirmed: [rag-chunking-platform-v2.md](./rag-chunking-platform-v2.md).
- The V1 PRD remains as historical context: [rag-chunking-platform-v1.md](./rag-chunking-platform-v1.md).
- The domain glossary is maintained in [CONTEXT.md](../CONTEXT.md).
- Five architectural decisions are recorded under [adr](./adr): parser-output normalization, asset/vector separation, preview staging, accurate semantic-strategy naming, and exact source-segment provenance.

## Existing V1 Runtime

The current prototype already provides:

- Fastify server and static web UI;
- multi-file upload and per-document MinerU polling;
- MinerU result ZIP normalization plus Markdown/TXT local parsing;
- LlamaIndex SentenceSplitter and TokenTextSplitter;
- a custom sentence-window embedding-distance semantic splitter;
- basic image/table policies;
- basic text editing, split, merge, exclusion, and JSON export;
- local embedding integration configured through `.env`.

These are implementation assets to reuse where they satisfy V2 contracts. They are not evidence that V2 is complete.

## Verified Baseline

Verified on 2026-08-12 from `D:\develop\RAG`:

```powershell
npm test
npm run typecheck
npm run build
```

All three commands passed. The current test reports `chunking self-check passed`.

## Known V1 Gaps To Replace

- Text splitters run independently inside each Content Block.
- Short adjacent blocks do not aggregate, so changing `chunkSize` often has no structural effect.
- `chunkOverlap` cannot operate across block boundaries.
- Provenance is limited to block IDs instead of exact Source Segments.
- The source pane is a text-block list rather than an original-page/bbox review surface.
- Preview, confirmed Draft, and human revisions are not fully separated.
- Context Candidate selection, Context Enhancement review states, invalidation, and embedding-text export do not exist.
- Workspace state is held in process memory and does not satisfy the V2 recovery contract.

## Repository Facts

- Package manager scripts are defined in `package.json`.
- Primary source files are `src/*.ts`, `app.js`, `index.html`, and `styles.css`.
- The directory is currently not a Git repository; do not assume commits, branches, or worktrees are available.
- Secrets are stored in `.env`; never print them, copy them into docs, or include them in exports.

## Source Of Truth Order

When documents appear to conflict, use this order:

1. Confirmed V2 PRD.
2. ADRs and `CONTEXT.md`.
3. Current phase `Plan.md`.
4. `PROJECT_STATUS.md` for execution state only.
5. V1 code and V1 PRD as reusable historical baseline.

## PRD 2.0 Plan Consolidation

### Status Boundary

The four V2.1 implementation plans are complete as planning documents. V2 remains `Overall status: completed` on the historical twelve-criterion baseline. V2.1 functionality is **not implemented**: `implementationStatus=not_started`, and no plan, test, screenshot, export, or baseline command below is evidence of V2.1 runtime completion.

### Plan Map And Dependency Graph

```text
PRD 2.0 + CONTEXT.md + ADRs
          |
        V21-G1 -> V21-G2 -> V21-G3 -> V21-G4
          |       |         |         |
       Plan 01 Plan 02   Plan 03   Plan 04
```

| Gate | Plan | Primary scope | Entry dependency | Exit contract |
| --- | --- | --- | --- | --- |
| `V21-G1` | [Plan 01](plans/v21-01-input-normalization-chunking/Plan.md) | Input routing, Visual Copy metadata, four-layer normalization, content types, qualification, IDs, four split strategies and Preview | PRD/ADR/CONTEXT facts and V2 baseline | Versioned Parsed Document and Preview with exact Source Segments and no guessed provenance |
| `V21-G2` | [Plan 02](plans/v21-02-review-workbench/Plan.md) | Continuous source review, mapping/highlight, Preview/Draft isolation, dirty gate, typed edits, recompute, undo/redo, responsive UI | `V21-G1` evidence | Server-authoritative reviewed Draft with stable/replaced IDs and persisted dirty-preview protection |
| `V21-G3` | [Plan 03](plans/v21-03-contextual-retrieval-export/Plan.md) | Selective Context recommendation/selection/lifecycle, eligibility, stale handling, embedding invariant, ordinary/partial/Legacy export and diagnostic package | `V21-G2` evidence | Auditable Context and export contracts with no stale or ineligible embedding text |
| `V21-G4` | [Plan 04](plans/v21-04-migration-ui-acceptance/Plan.md) | Legacy/replacement isolation, fixed samples, real browser QA, UI/export comparison, final acceptance | `V21-G1`, `V21-G2`, `V21-G3` evidence | A 32-item evidence matrix and a future V2.1 completion decision; until then status stays not implemented |

Five PRD capability domains remain mapped to these four gates; they do not create a fifth gate. Plan order is strictly 01 -> 02 -> 03 -> 04.

### PRD Sections 4-20 Coverage

| PRD section | Unique work-unit coverage | Evidence type |
| --- | --- | --- |
| §4 Product boundary and workflow | P04-02, P04-04 | end-to-end fixture report and matrix |
| §5 Source Document and replacement | P04-01 | migration state JSON and reparse test |
| §6 Input routing and MinerU | P01-01 | adapter contract test and status-only logs |
| §7 Visual Copy and source views | P01-01, P02-01 | lifecycle test plus browser screenshots |
| §8 Content Block and four-layer model | P01-02 | normalization fixture assertions |
| §9 Structured content types and protected groups | P01-03 | typed/protected red-green tests |
| §10 Provenance, IDs and mapping quality | P01-03, P02-01 | Source Segment fixture and bbox mapping evidence |
| §11 Qualification and embedding eligibility | P01-04, P03-02 | qualification matrix and embedding assertions |
| §12 Chunking strategies and overlap | P01-05 | strategy/overlap test and Preview artifact |
| §13 Review workbench interactions | P02-01 through P02-04 | desktop/mobile browser workflow |
| §14 Preview, Draft and revision rules | P02-02, P02-03 | dirty-gate and revision persistence tests |
| §15 Contextual Retrieval | P03-01, P03-02 | fake-model lifecycle and stale tests |
| §16 V2.1 workflow acceptance | P04-02 through P04-04 | end-to-end run, browser logs and matrix |
| §17 New V2.1 acceptance criteria | P04-04 with unique owners below | 20-item evidence matrix |
| §18 Export, partial batches and diagnostics | P03-03, P03-04 | manifest, allowlist and expiry evidence |
| §19 Implementation mapping and gate order | all four Plans | dependency/gate audit |
| §20 Risks, recovery and non-goals | each Plan recovery section; P04-04 | checkpoint and residual-risk record |

### Unique Acceptance Ownership

Each criterion has exactly one implementation owner. Plan 04 performs the final cross-check but is not a second owner.

| Criterion | Owner work unit | Required evidence |
| --- | --- | --- |
| `V2-AC01` | P01-05 | four strategies fixture |
| `V2-AC02` | P01-05 | size/overlap Preview assertions |
| `V2-AC03` | P01-05 | Source Segment/metric assertions |
| `V2-AC04` | P02-01 | source viewer browser evidence |
| `V2-AC05` | P01-02 | normalized content fixture |
| `V2-AC06` | P01-03 | protected table/group fixture |
| `V2-AC07` | P02-02 | dirty parameter gate test |
| `V2-AC08` | P02-03 | server recomputation test |
| `V2-AC09` | P03-01 | candidate recommendation test |
| `V2-AC10` | P03-02 | Context lifecycle/embedding test |
| `V2-AC11` | P03-01 | selected-only generation test |
| `V2-AC12` | P04-04 | final integrated matrix |
| `V21-AC01` | P01-01 | Office direct MinerU routing |
| `V21-AC02` | P01-01 | Visual Copy independent failure |
| `V21-AC03` | P02-01 | original continuous source surface |
| `V21-AC04` | P02-01 | exact/degraded mapping and no guessed bbox |
| `V21-AC05` | P02-01 | bidirectional highlight |
| `V21-AC06` | P01-03 | table HTML isolation |
| `V21-AC07` | P01-02 | four content layers |
| `V21-AC08` | P02-03 | typed edit and unified recompute |
| `V21-AC09` | P01-04 | qualification matrix and immutable version |
| `V21-AC10` | P03-02 | target eligibility gate |
| `V21-AC11` | P03-02 | skipped ineligible neighbors and scope |
| `V21-AC12` | P02-03 | local revision contract |
| `V21-AC13` | P02-04 | document recompute/ID replacement |
| `V21-AC14` | P04-01 | Legacy detection and reparse isolation |
| `V21-AC15` | P03-03 | ordinary and partial manifest export |
| `V21-AC16` | P03-04 | independent diagnostic package and expiry |
| `V21-AC17` | P01-02 | all first-release content types |
| `V21-AC18` | P03-02 | Context stale and embeddingText invariant |
| `V21-AC19` | P04-03 | responsive browser/runtime evidence |
| `V21-AC20` | P03-04 | secret boundary and diagnostic redaction |

### Non-Negotiable Contracts

- PDF/image use original uploaded pages; Office files are sent to MinerU and require an independent Visual Copy conversion path. A Visual Copy failure is explicit quality state, never a silent parse fallback.
- Missing coordinates never become invented bbox or Source Segment data. Mapping quality is explicit (`exact`, `degraded`, `unavailable`).
- Every Content Block carries `raw`, `normalized`, `display`, and `searchText` layers. Raw table HTML may be retained only as structured diagnostic/source evidence; `<tr>`/`<td>` cannot enter ordinary readable text or embedding text.
- Qualification, location quality and embedding eligibility are separate. `embeddingEligible=false` implies `embeddingText=null`.
- Context is selected, scoped and auditable. It never mutates `finalText`; stale Context stays review-visible but never enters `embeddingText`, and ineligible neighbors are skipped with reasons.
- Ordinary exports are explicit-field allowlists. Legacy and V2.1 bodies never mix; partial manifests expose `pending` and `failed` states. Diagnostic packages are separate, allowlisted and expiring.
- No semantic-model silent fallback, protected-content truncation, fabricated Source Segment, secret/API-key/request-detail leakage, or PRD-excluded feature is allowed.

### State, Recovery And Risk Protocol

Before each work unit, update `PROJECT_STATUS.md` with the Plan/unit red-evidence command and assumptions. After each meaningful change record files, exact command result, artifact paths, risks and next action. An interrupted command is `unknown` and must be rerun. After two identical failures change the diagnostic method or narrow the fixture; pause only for an authorized external/production/product blocker. Recovery order is `PROJECT_STATUS.md` -> PRD 2.0 -> this Consolidation -> `CONTEXT.md`/ADRs -> active Plan -> source/tests. Never read `.env` or record credentials. The repository has no Git history, so hashes and QA artifacts are the durable drift check.

| Risk | Detection | Mitigation/owner |
| --- | --- | --- |
| Office/PDF conversion unavailable | Visual Copy status and browser nonblank check | explicit failure state and controlled fixture; P01/P02 |
| Mapping lacks coordinates | mapping-quality assertions | do not fabricate bbox; P01/P02 |
| Protected table/content split | oversized and cross-page fixtures | atomic group/row rules; P01 |
| Context stale or ineligible text embedded | lifecycle and exact embedding assertions | null/ignore stale text; P03 |
| Legacy mixed with V2.1 | manifest format scan | explicit format selection and reparse; P03/P04 |
| Secret or diagnostic leakage | allowlist and redacted log scans | separate expiring package; P03 |
| Responsive/export mismatch | real browser and field comparison | block G4 until corrected; P04 |

### Next Step

The next executable action is Plan 01 only: record its red evidence, then implement the smallest failing contract. No V2.1 code, migration, external model call, deployment or production-data operation is authorized by this planning deliverable. The plan consolidation is complete; V2.1 functionality remains not implemented.

## V2.1 Implementation Consolidation

### Current Gate State

| Gate | Status | Durable evidence |
| --- | --- | --- |
| `V21-G1` | completed 2026-08-13 | `qa/v21-g1-contract-evidence.json`; Plan 01 implementation evidence; passing test/type/build/syntax and static scans |
| `V21-G2` | completed 2026-08-13 | Plan 02 focused/full tests; server-owned review actions; exact 1440x1000 and 390x844 screenshots; clean browser/service logs |
| `V21-G3` | completed 2026-08-16 | P03 focused/full gates; one real DashScope smoke; deterministic failure/retry/manual/stale browser QA; Contract 2.1 export and clean logs |
| `V21-G4` | pending | final 32-item acceptance remains open |

G1 implemented the parser-neutral Contract 2.1 input, Visual Copy, four-layer normalization, protected-content, provenance, qualification and Preview boundaries. G2 implemented the real-source review workbench, persisted dirty-preview protection, typed server recomputation, server-owned structural actions, replacement IDs, undo/redo, responsive interaction and strict log redaction. V2.1 overall remains `in_progress`; G3 Context/export and G4 migration/final acceptance are still open. This section supersedes the earlier planning-only next step without rewriting historical V2 evidence.
