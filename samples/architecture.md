# Marginalia Architecture Overview

This document is a developer-facing architecture sketch. It complements the full design in `DESIGN.md`.

Marginalia's current architecture is optimized for a personal-library research
agent rather than a pure vector database. The system can behave like hybrid
RAG for quick lookup, but its strongest path is multi-step ReAct
investigation: locate candidate materials, verify metadata, read original
source windows, follow related evidence, and produce a cited report.

## 1. System Shape

```text
CLI / desktop / HTTP client
        |
        v
FastAPI app (`marginalia.main`)
        |
        +-- synchronous request handlers
        |     upload, folders, entries, search, chat, export, settings
        |
        +-- TaskRunner
              ingest, reflect, tag quality, relation mining,
              catalog maintenance, pruning, lifecycle suggestions
```

Default mode embeds everything in one process:

```text
marginalia
  -> CLI REPL
  -> httpx ASGITransport
  -> FastAPI app
  -> in-process TaskRunner
```

Remote mode runs the API separately:

```text
marginalia --server http://host:8000
  -> HTTP
  -> uvicorn marginalia.main:app
```

## 2. Layers

```text
User-visible layer
  folders
  file_entries
  files

AI-internal retrieval layer
  catalogs
  views
  tags
  tag_aliases
  entry_tags
  entry_relations
  journal

Session and audit layer
  sessions
  conversations
  audit_events

Infrastructure layer
  tasks
  task_outcomes
```

Important separation:

- `files` describe immutable bytes.
- `file_entries` describe a file placement in the user's library.
- `journal` is the agent's persistent investigation memory.
- `entry_relations` is the evidence-discovery graph.
- `audit_events` is operational history, not retrieval memory.

## 3. Request Paths

### Upload and Ingest

```text
POST /v1/upload
  -> store bytes in mirror/local/s3
  -> create/reuse files row
  -> create file_entries row
  -> enqueue ingest_file

ingest_file
  -> resolve pipeline
  -> extract text/metadata/sections
  -> call ingest LLM profile where needed
  -> write files.summary / description / extra / kind
  -> assign catalog and tags
```

Pipelines:

```text
text
pdf
image
docx
spreadsheet
log
archive
```

### Chat Turn

```text
POST /v1/chat/{session_id}
  -> create conversation
  -> build stable snapshot
  -> plan LLM call
  -> execute LLM loop with tools
     quick mode: up to two tool-capable passes, then forced answer
     deep mode: configured full ReAct budget
  -> stream SSE events
  -> persist answer and metrics
  -> enqueue reflect_turn
```

The execute loop can call:

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

### Reflection

```text
reflect_turn
  -> replay same stable prefix shape as execute
  -> append compact current-turn summary
  -> ask reflect profile for one <entry> block
  -> insert journal row
```

The journal row is what future turns search. Raw conversations are persisted for audit/export, not used as primary retrieval memory.

## 4. Retrieval Funnel

```text
recall_knowledge
  -> resolve tag hints
  -> search journal notes
  -> search metadata by tags/text
  -> optional semantic recall
  -> RRF-style merge and scoring
  -> optional rerank
  -> quota or reranked evidence selection
  -> one-hop related-entry expansion
  -> batched metadata verification
  -> original source read
  -> cited answer
```

The funnel intentionally delays expensive raw-file reads until candidates are plausible.
`recall_knowledge` is the preferred high-level first pass for broad
knowledge-base questions. Lower-level tools remain available for focused
follow-up:

```text
materialize_view      expand a saved view into entry IDs
search_metadata       direct metadata/tag/folder/view recall
search_journal        prior-investigation memory
read_entries_metadata inspect sections, summaries, tags, and related entries
read_files            source-grounded evidence read
```

Views are still explicit tools rather than an implicit global filter:
`materialize_view` reads `View.filter_spec`, while `search_metadata(view_id=...)`
searches within a materialized view. This keeps ReAct control visible to the
agent instead of silently changing every recall call.

### Hybrid Recall Internals

```text
tag seeds
  -> resolve_tag
  -> search_metadata(tags_any=...)
  -> search_journal(tags=...)

text seeds
  -> search_metadata(text=[...])
  -> search_journal(text=[...])
  -> semantic_entry_rows(query) when SEMANTIC_RECALL_ENABLED=true

merged entries
  -> score_recall_entries(rank sources + text overlap)
  -> rerank_recall_entries when RERANK_ENABLED=true
  -> select_evidence_entries(strategy=quota|rerank)
```

The semantic path is optional. Embedding credentials use `EMBEDDING_*`, never
`LLM_*`; rerank uses `RERANK_*`, never chat or vision keys. The default
embedding endpoint is DashScope/Bailian's OpenAI-compatible
`text-embedding-v4`. If `sqlite-vec` is installed, the semantic index writes
`vectors.sqlite`; otherwise it falls back to the file index. The current public
CLI builder is eval-dataset scoped; the internal index API can index arbitrary
entry IDs, but a whole-library semantic-index command has not been exposed yet.

`read_files` provides targeted source access:

- text sections, headings, line ranges, regex matches;
- PDF physical page windows, page labels, regex matches;
- DOCX paragraph ranges;
- archive member paths;
- bounded offsets for long documents.

## 5. Evidence Graph

Background relation discovery turns usage and structure into retrieval hints.

```text
mine_relations
  -> session co-occurrence
  -> tag overlap
  -> citation co-citation
  -> corpus evidence candidates
  -> entry_relations

vet_relations
  -> LLM gate
  -> vetted=True/False

services.recommend.find_related
  -> random walk with restart
  -> related entries in search/metadata/discover
```

The online agent does not need to understand all mining signals. It receives related entries as compact candidates.

## 6. Long Document Strategy

Long files are never assumed to fit in one prompt.

Text:

- normal reads cap bytes according to requested window;
- deep reads can scan more for heading, line, section, or pattern lookup.

PDF:

- ingest can chunk or partially index long documents;
- readback extracts requested page windows;
- default reads return continuation hints;
- page labels are supported, but physical pages are the stable viewer locator;
- citation display tries quote location first.

## 7. Task Scheduling

The task queue is database-backed. No broker is required.

Important mechanics:

- priority controls claim order;
- leases and heartbeats recover crashed workers;
- active `dedup_key` uniqueness avoids duplicate background work;
- `task_outcomes` records idempotent effects and periodic recency.

Task families:

```text
online-adjacent: reflect_turn, ingest_file
self-healing:    recover_stuck_tasks
maintenance:     tag_quality, restructure_catalogs, suggest_lifecycle
discovery:       mine_relations, vet_relations, propose_views, refresh_entry_extra
retention:       purge_deleted_files, prune
dispatcher:      periodic_tick
```

Eval imports and semantic indexing are intentionally batchable:

```text
eval import-beir --concurrency N --resume
  -> create normal file entries
  -> run ingest synchronously
  -> persist dataset manifest and qrels mapping

eval build-semantic-index --concurrency N --resume
  -> batch embedding requests
  -> write file index
  -> optionally write sqlite-vec index
```

## 8. Evaluation and Validation

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

This split matters architecturally. Marginalia is not trying to be only the
best ranker; the product outcome is a source-grounded investigation report.
Ranking metrics are diagnostics for the candidate pool, while answer/report
metrics test whether the system can actually use evidence.

Current local SciFact validation supports the design direction:

```text
retrieval, 300 queries, recall_knowledge + rerank top-80:
  MRR 0.7226, hit@10 0.8800, hit@100 0.9133

bounded answer-run, 300 queries, rerank top-80 + quota:
  evidence hit 0.8667, citation hit 0.7133, label accuracy 0.8085

end-to-end report comparison, 30 queries:
  ReAct wins 26, one-shot RAG wins 2, ties 2, timeouts 1
```

These are local validation results, not a general SOTA claim. They justify
advertising the system as strong for personal-library research reports, with
the explicit tradeoff that ReAct uses more LLM calls and has higher latency
than one-shot RAG.

## 9. Storage

Backends:

```text
mirror  readable folder tree under <home>/library
local   UUID object pool under <home>/objects
s3      remote object storage
```

Startup checks whether existing `storage_key` shapes match the configured backend. If not, the operator must migrate or restore the previous backend.

## 10. Deployment Choices

Personal library:

```text
SQLite + mirror + embedded CLI
```

High-churn local library:

```text
SQLite + local + embedded CLI
```

Shared or multi-host library:

```text
Postgres + S3 + API server + worker
```

SQLite is appropriate for one writer process. Use Postgres when multiple processes or machines can write.

## 11. Release Pipeline

The release workflow builds desktop artifacts in parallel, but only one job
mutates the GitHub Release:

```text
desktop matrix
  -> windows-x64
  -> windows-arm64
  -> macos-x64
  -> macos-arm64
  -> linux-x64
  -> linux-arm64
  -> upload workflow artifacts

docker
  -> build and push multi-arch ghcr.io image

publish-release
  -> download all desktop artifacts
  -> verify the expected 12 assets
  -> create/update the GitHub Release once
  -> verify release assets
```

This avoids the draft-release race that can happen when multiple matrix jobs
directly upload to the same Release, while preserving parallel build time.

## 12. Design Boundaries

Marginalia is not a vector search engine, a chat memory database, or a document summarizer that treats summaries as final evidence.

The intended contract is:

```text
structured narrowing
  + durable investigation memory
  + evidence graph
  + original-source verification
  = trustworthy private-library retrieval
```
