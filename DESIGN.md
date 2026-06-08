# Marginalia Design

Marginalia is a local-first research agent for a private heterogeneous
knowledge base. It is built around five commitments:

1. **Structured retrieval before raw reading**: the agent narrows candidates through journals, folders, catalogs, tags, views, summaries, extra fields, high-level recall, and relation discovery before opening source files.
2. **Persistent investigation memory**: completed turns write compact journal entries. Future turns search those entries before repeating work.
3. **Recommendation-style evidence discovery**: background tasks mine relations between entries, LLM-vet noisy edges, and expose related entries during search and metadata reads.
4. **Optional semantic assistance, not vector-first control**: embeddings, `sqlite-vec`, and reranking can improve recall when configured, but they sit behind the structured funnel rather than replacing it.
5. **Original-source verification**: answers are expected to cite source entries and, when possible, exact quotes or physical PDF pages.

This document describes current code behavior. It is not a product roadmap.

## 1. Retrieval Model

Marginalia deliberately avoids a vector-first design. The core retrieval path
is a funnel, with `recall_knowledge` as the preferred first-pass tool for broad
material location:

```text
question
  -> recall_knowledge
      -> resolve tag hints
      -> search_journal
      -> search_metadata by tags/text
      -> optional semantic recall
      -> RRF-style merge and scoring
      -> optional rerank
      -> quota or reranked evidence selection
      -> one-hop related-entry expansion
  -> read_entries_metadata
  -> focused list_folder / search_metadata / materialize_view follow-up
  -> related_entries / discover
  -> read_files
  -> cited answer
  -> reflect_turn journal entry
```

The first stages are cheap and structured; the final stage reads original
content. The LLM is responsible for semantic judgement, but it must operate
through tools with explicit database and file boundaries.

### 1.1 Search Surfaces

- `journal.note`, `journal.tags`, and `journal.entry_ids` recall prior investigations.
- `file_entries.display_name` captures user-facing placement and naming.
- `files.summary`, `files.extra`, and `file_entries.extra` capture content and position-specific interpretation.
- `catalogs`, `views`, `tags`, and `entry_tags` provide structured access points.
- `entry_relations` supplies recommendation-style neighbours.
- `semantic-index/default` can supply optional embedding candidates when
  `SEMANTIC_RECALL_ENABLED=true`.
- `read_files` is the verification layer and returns source text slices.

Text search in metadata paths uses compact metadata fields and the local
metadata search implementation; it is separate from embedding search.
Embedding recall is optional and never reuses chat, vision, or ingest keys.

### 1.2 Capability Boundary

Marginalia is strongest for source-grounded investigation over a personal
library: finding relevant materials, reading the right slices, reconciling
evidence, and producing a cited report. For quick factual lookup it behaves
like a hybrid RAG system. For research-style questions, the full ReAct workflow
can be more capable than one-shot top-k RAG because it can iterate through
journal recall, metadata inspection, relation discovery, and source reads.

This is not a claim of general benchmark SOTA. The current validation supports
a narrower claim: on local SciFact evaluation, the ReAct report workflow beat
a one-shot RAG report baseline in most sampled end-to-end comparisons, with
higher latency and more LLM calls.

### 1.3 Citation Contract

Agent answers use a machine-parseable footnote protocol:

```text
[^a]: entry_id=<id>, quote="<verbatim excerpt>", page=<n> - <reason>
```

Rules:

- `entry_id` must come from a real tool result in the current turn.
- `quote` is preferred whenever source text exists.
- `page` is only for PDF physical pages, not printed page labels guessed from the document body.
- PDF display links try quote-location first, then fall back to page/page-label mapping.
- Multiple evidence locations require multiple footnotes.

The raw response is persisted; live display rewrites footnotes to entry links.

## 2. Data Model

The schema is organized into four layers.

```text
User-visible:
  folders, file_entries, files

AI-internal:
  catalogs, views, tags, tag_aliases, entry_tags,
  entry_relations, journal

Audit/session:
  audit_events, sessions, conversations

Infrastructure:
  tasks, task_outcomes
```

### 2.1 User-visible Layer

#### `folders`

Represents the user's folder tree. Folders are user-owned and soft-deleted.

Important fields:

- `parent_id`
- `name`
- `deleted_at`

#### `files`

Represents immutable file content and content-level AI fields.

Important fields:

- `storage_key`
- `sha256`
- `size_bytes`
- `mime_type`
- `original_ext`
- `kind`
- `summary`
- `description`
- `extra`
- `ingest_status`
- `ingested_at`
- `deleted_at`

`summary`, `description`, `extra`, and `kind` describe the bytes. They are written by ingest and guarded as content-level state.

#### `file_entries`

Represents one placement of a file in the user's library.

Important fields:

- `folder_id`
- `file_id`
- `display_name`
- `lifecycle`
- `catalog_id`
- `extra`
- `deleted_at`
- `purge_after`

The same `files` row can appear in multiple folders through multiple `file_entries`. Per-placement interpretation lives on `file_entries.extra` and `catalog_id`.

### 2.2 AI-internal Layer

#### `catalogs`

An AI-maintained classification tree. The `_inbox` system catalog is seeded at bootstrap.

Fields include:

- `parent_id`
- `name`
- `summary`
- `description`
- `extra`
- `tags`
- `is_system`
- `deleted_at`

#### `views`

Saved AI-discovered filters over the library. `filter_spec` can combine
catalog, tag, lifecycle, and related structured filters. `materialize_view`
computes members on demand. Views are explicit tools, not an invisible global
filter: `search_metadata(view_id=...)` searches within a materialized view when
the agent chooses that path.

#### `tags` and `tag_aliases`

Controlled vocabulary with facets:

```text
topic, form, time, source, language, extra
```

`tag_aliases` records permanent alias history. `normalize_tags` merges synonyms and case/spelling variants; `tag_quality` recomputes useful tag state.

#### `entry_tags`

Many-to-many edge between entries and tags. `source` records provenance such as ingest, enrichment, or dedup seed.

#### `entry_relations`

Undirected relation between two entries. The service layer stores pairs in canonical order.

Important fields:

- `entry_a_id`
- `entry_b_id`
- `note`
- `source_kind`
- `observation_count`
- `last_observed_at`
- `vetted`
- `vetted_reason`
- `vetted_at`

Relation miners insert observations. `vet_relations` decides whether they are useful for future retrieval.

#### `journal`

Append-only investigation memory.

Important fields:

- `conversation_id`
- `note`
- `entry_ids`
- `tags`
- `source_kind`
- `superseded_by_id`
- `summarized_journal_ids`

`reflect_turn` writes per-turn journal entries. `summarize_session` can synthesize longer-lived session insights and supersede older rows.

### 2.3 Audit/session Layer

#### `audit_events`

Human-readable event stream for data changes and task lifecycle. It is not an agent memory source.

#### `sessions`

One user interaction window with aggregate counters:

- turn count
- token totals
- cache read totals
- tool/LLM call totals
- duration and cost estimates

#### `conversations`

One turn inside a session. Stores:

- user message
- final agent response
- tool call records
- LLM call records
- aggregate counters

The agent does not use `conversations` as long-term memory; journal is the recall layer.

### 2.4 Infrastructure Layer

#### `tasks`

Database-backed async queue. It supports:

- `pending`, `running`, `done`, `failed`, `dead`
- priority
- attempts
- leases and heartbeats
- active deduplication through `dedup_key`

No external broker is required.

#### `task_outcomes`

Durable record of task effects. Used for idempotence and scheduling decisions. Periodic tasks consult `task_outcomes` rather than audit logs.

## 3. File Ingest

Upload creates or reuses a `files` row, creates a `file_entries` placement, and queues `ingest_file`.

Ingest resolves a pipeline by MIME, extension, and filename pattern:

- `text`
- `pdf`
- `image`
- `docx`
- `spreadsheet`
- `log`
- `archive`

Pipeline output:

- `kind`
- `summary`
- `description`
- `extra`
- suggested catalog path
- suggested tags
- optional structured sections

### 3.1 Long Documents

Long text and PDF handling is windowed.

- Text reads default to a byte cap proportional to the requested window.
- Deep text reads may scan more for section, heading, line, or pattern matching.
- PDF readback extracts only requested page windows where possible.
- Default PDF reads are capped and return continuation hints such as `next_page_start`.
- PDF page labels are supported, but physical page numbers remain the stable browser locator.

Ingest may index only a prefix or chunked section map for very large PDFs. Coverage metadata records partial indexing.

### 3.2 Scanned PDFs and Images

Vision is optional. If configured:

- image ingest can ask a vision model for descriptions;
- PDF ingest can describe embedded figures;
- scanned PDFs can fall back to full per-page OCR. A deployment may still
  configure an explicit OCR page cap, but the default is uncapped so stored
  OCR text does not silently lose later pages.

If vision is absent, scanned PDFs fail with an actionable "needs OCR" state rather than pretending empty text is valid.

## 4. Agent Runtime

Each turn has two LLM phases.

### 4.1 Plan Phase

The planner has no tools. It outputs either:

- `NO_PLAN: ...` for trivial turns, or
- a plain numbered tool plan for execute.

The plan must not answer from the snapshot.

### 4.2 Execute Phase

The executor receives:

- stable system prompt;
- frozen snapshot of catalogs, views, tags, and pre-session journal rows;
- resumed session history, when applicable;
- current user message;
- plan text;
- tool definitions.

It can call registered tools and then produce a cited answer.

Execution mode is request-scoped:

- `deep` is the default full ReAct loop and uses the configured execute-turn
  budget;
- `quick` still runs the planner, then caps execute to three calls: the first
  two may call tools, while the third disables tools and must answer from
  collected evidence.

Runtime guards:

- duplicate call reuse;
- duplicate call within a batch collapse;
- doom-loop nudge for repeated near-duplicate tool calls;
- max execute turn budget;
- structured truncation of oversized tool results.

### 4.3 Stable Snapshot

The snapshot is an overview, not evidence. Journal rows in the snapshot are frozen to rows created before the session started so the agent does not feed its own current-session reflections back into the next plan.

## 5. Agent Tools

Registered tools:

```text
recall_knowledge
search_journal
list_folder
list_catalogs
read_catalog
resolve_tag
materialize_view
search_metadata
read_entries_metadata
read_files
query_log
query_sql
analyze_container
generate_chart
```

Important retrieval tools:

- `recall_knowledge`: preferred broad material-recall entrypoint. It resolves tag hints, searches journal notes and metadata, optionally adds semantic candidates, ranks/merges the pool, optionally reranks, applies evidence selection, and returns candidates for metadata verification and source reads.
- `search_journal`: prior investigation memory; supports text, entry, tag, and time filters. Tag lookup is OR-style.
- `search_metadata`: structured candidate narrowing by text, tags, catalog, folder, view, kind, and lifecycle.
- `read_entries_metadata`: compact metadata, sections, coverage, and related entries.
- `read_files`: original-source verification by offset, section, heading, line, page, PDF label, paragraph, regex, archive member, or table-aware slice.
- `query_sql`: DuckDB-backed querying for supported table formats.
- `analyze_container`: inspect archive members without fully flattening every possible nested item into the main library.

### 5.1 Optional Semantic Recall and Rerank

Semantic recall is opt-in:

```text
EMBEDDING_API_KEY=...
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_MODEL=text-embedding-v4
SEMANTIC_RECALL_ENABLED=true
SEMANTIC_INDEX_BACKEND=auto        # auto, file, sqlite-vec
```

The embedding profile is separate from `LLM_*`; no chat, ingest, or vision key
is reused implicitly. The public eval CLI builder is eval-dataset scoped. The
GUI/API can enqueue a whole-library rebuild of the default semantic index when
embedding provider/model/dimensions change, while successful ingest refreshes
only the affected file's semantic vectors.

Rerank is also opt-in:

```text
RERANK_ENABLED=true
RERANK_API_KEY=...
RERANK_MODEL=qwen3-rerank
RERANK_TOP_N=80
EVIDENCE_SELECTION=quota           # quota or rerank
```

`EVIDENCE_SELECTION=quota` preserves diversity across overlapping, tag,
lexical, and semantic signals. `EVIDENCE_SELECTION=rerank` takes the reranked
order directly.

## 6. Evidence Discovery

Relation discovery is background work. It reduces online agent loops by surfacing likely neighbours once a seed entry is known.

Signals:

- session co-occurrence from journal rows;
- tag overlap;
- citation co-citation inside agent answers;
- corpus-evidence review for candidate pairs.

Pipeline:

```text
mine_relations
  -> entry_relations observations
  -> vet_relations
  -> vetted entry_relations
  -> services.recommend random walk
  -> /discover and related_entries
```

`find_related` uses random walk with restart over the relation graph. Search and metadata surfaces can prefill related entries so the agent does not spend another loop rediscovering obvious neighbours.

## 7. Background Task System

Task kinds:

```text
reflect_turn
ingest_file
summarize_session
recover_stuck_tasks
purge_deleted_files
tag_quality
restructure_catalogs
suggest_lifecycle
mine_relations
vet_relations
propose_views
refresh_entry_extra
prune
periodic_tick
```

`periodic_tick` dispatches recurring maintenance. Event-driven tasks such as `ingest_file` and `reflect_turn` are queued immediately after upload or completed chat turns.

LLM-dependent task kinds fail fast when required profile credentials are missing.

## 8. Evaluation and Validation

Evaluation is part of the design because the system's goal is a final
source-grounded report, not only a ranked list.

`marginalia eval` has three layers:

```text
run
  -> candidate-pool metrics: hit@k, candidate_recall@k, nDCG, MRR

answer / answer-run
  -> bounded retrieval + bounded source reads + one final-answer LLM call
  -> evidence hit, citation hit, optional label accuracy

compare-report
  -> one-shot RAG report
  -> full ReAct report workflow
  -> blind pairwise judge, with gold labels prioritized when available
```

External BEIR-style datasets are imported as normal file entries. Import runs
ingest synchronously and supports `--concurrency` and `--resume`. Semantic
index builds also support batched concurrent embedding requests and resume.

Current local SciFact validation:

```text
retrieval, 300 queries, recall_knowledge + rerank top-80:
  MRR 0.7226, hit@10 0.8800, hit@100 0.9133

bounded answer-run, 300 queries, rerank top-80 + quota:
  evidence hit 0.8667, citation hit 0.7133, label accuracy 0.8085

end-to-end report comparison, 30 queries:
  ReAct wins 26, one-shot RAG wins 2, ties 2, timeouts 1
```

These results justify describing Marginalia as strong for personal-library
research reports, while keeping the claim bounded to local validation and the
tested comparison setup.

## 9. Storage

Backends:

- `mirror`: readable folder tree under `<MARGINALIA_HOME>/library`.
- `local`: UUID-flat object pool under `<MARGINALIA_HOME>/objects`.
- `s3`: remote object storage for multi-host deployments.

The app checks storage-key shape at startup so switching backend without migration fails clearly. Migration is handled by:

```bash
marginalia storage migrate --from mirror --to local
marginalia storage migrate --from local --to mirror
```

S3 is intended for Postgres-backed deployments.

## 10. Lifecycle

Entry lifecycle values:

```text
active
demoted
archived
manual_active
manual_archived
```

Automatic transitions are disabled by default:

```ini
AUTO_LIFECYCLE_ENABLED=false
```

This preserves personal worker intent. Shared deployments may enable background demotion/archive suggestions for cost and recall management.

## 11. Invariants

- User files and folders are user-owned. AI does not mutate them directly through agent tools.
- AI-internal structures are not user-visible truth; they are retrieval aids.
- Audit logs are for humans and operations, not agent memory.
- Journal is the long-term investigation memory.
- The snapshot is not citable evidence.
- Citation `entry_id` values must come from current-turn tool results.
- Original-source reads are required for source-backed claims.
- Embedding and rerank credentials are independent from `LLM_*` profiles.
- Optional semantic recall must degrade to lexical/metadata recall when no
  valid semantic index or embedding key exists.
- Task idempotence belongs in `task_outcomes`, not ad hoc audit scans.
- Storage backend changes require migration, not just `.env` edits.
- Long documents must be read through targeted windows.

## 12. Deployment Shapes

Embedded default:

```text
marginalia CLI
  -> in-process ASGI app
  -> in-process TaskRunner
  -> SQLite + mirror/local storage
```

Remote:

```text
CLI or desktop
  -> FastAPI server
  -> TaskRunner
  -> Postgres + S3 or shared storage
```

Docker compose starts API, worker, Postgres, and MinIO.

## 13. Release Pipeline

Desktop and Docker releases are standard CI outputs. Desktop builds run in
parallel, upload workflow artifacts, and a single publish job mutates the
GitHub Release:

```text
desktop matrix
  -> windows-x64
  -> windows-arm64
  -> macos-arm64
  -> linux-x64
  -> linux-arm64
  -> upload workflow artifacts

docker
  -> build and push multi-arch ghcr.io image

publish-release
  -> download all desktop artifacts
  -> verify the expected 9 assets
  -> create/update the GitHub Release once
  -> verify release assets
```

This avoids draft-release races from multiple matrix jobs uploading to the
same Release while preserving parallel build time.

## 14. Non-goals

Current system behavior intentionally excludes:

- vector DB as the primary retrieval layer;
- opaque chunk stores as the source of truth;
- claiming general RAG/report-generation SOTA from local validation alone;
- automatic user-file deletion by AI;
- using audit logs or raw conversation history as retrieval memory;
- treating LLM-generated summaries as sufficient evidence when original text is available.
