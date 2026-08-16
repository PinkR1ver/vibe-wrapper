# DeepSeek Harness Word Cloud Adapter

Created: 2026-08-16
Status: completed
Goal: Make DeepSeek Harness a first-class prompt source so its authored prompts feed the vibe-coding word cloud, even though TokenTracker already supplies DSH token-activity counts.
Scope: A new `src/sources/dsh.js` adapter that reads DeepSeek Harness's local zstd-compressed session logs and returns normalized prompt records, plus registration, a CLI flag, and fixture-backed tests.

## Background

TokenTracker already counts DSH token activity (the `dsh` source appears in the local queue), but TokenTracker rows are activity-only and carry no prompt text, so DSH could never contribute to the word cloud. DSH persists each conversation as an append-only JSONL log under `<DSH_HOME>/sessions/<encoded-cwd>/<encoded-session-id>/session.jsonl.zstd`, where `DSH_HOME` defaults to `~/.dsh`.

## Implementation

- **Adapter**: `src/sources/dsh.js` walks `<sessions root>/**/session.jsonl` and `session.jsonl.zstd` (via the shared `walkFiles` helper) and returns the normalized report.
- **Decompression**: DSH artifacts are a concatenation of independently checksummed Zstandard frames (one per durable batch). The adapter prefers Node 22.15+ built-in `node:zlib` zstd (splitting frames with `scanZstdFrames`, then decoding each with `zstdDecompressSync`), and falls back to the `zstd -dc` CLI. Plain `session.jsonl` (compression `none`) is read directly. With neither decompressor, the adapter returns zero prompts with an explanatory note — never a crash.
- **Prompt extraction**: Keeps only `user/message` events whose `data.source.kind === "user"`. DSH appends synthetic `user/message` records for `agent-instructions` (AGENTS.md), `plugin` (runtime snapshots), `skill-catalog`, `subagent-report`, `subagent-settled`, `goal`, and `coordinator` — all excluded so they never enter word frequencies.
- **Token totals**: Empty. DSH token counts stay with TokenTracker activity to avoid double-counting.
- **Registration**: Added to `SOURCE_INSPECTORS` and `DEFAULT_SOURCES` in `src/sources/index.js`; `KNOWN_SOURCES` picks it up automatically.
- **CLI**: `--dsh-root <path>` flag added to `bin/vibe-roast.js` for custom session roots.
- **Word cloud**: Works automatically — adapter `prompts[].text` feeds the existing `wordCloudRecords → wordFrequenciesFromRecords` pipeline.

## Testing

- Plain fixture at `test/fixtures/dsh/sessions/**` with two sessions covering authored prompts, injected envelopes, and an out-of-range prompt; a zstd fixture (two concatenated frames) at `test/fixtures/dsh/zstd-sessions/**`.
- 8 tests in `test/dsh.test.js`: root resolution, envelope exclusion, date filtering, missing-root behavior, frame scanning, zstd read (skipped when no decompressor), registration, and word-cloud integration.
- Full suite passes (165 tests).

## Limitations

- Requires a zstd decompressor: Node 22.15+ (built-in `node:zlib`) or the `zstd` CLI on PATH. DSH itself needs Node 22.15+, so DSH users always have the built-in path.
- Token attribution is TokenTracker-only; the adapter intentionally contributes no token totals.
- The frontend `AgentIcon.jsx` / `UsageAnalytics.jsx` badge and color maps were left untouched to avoid a broad Prettier reformat of pre-existing non-compliant files; DSH renders with the generic fallback label/color.

## Completion

- [x] Adapter reads prompts from DSH zstd/plain session logs
- [x] Injected envelopes excluded from authored prompts
- [x] Registered in source registry and default list
- [x] CLI `--dsh-root` flag
- [x] Fixture-backed tests with missing-root, date-range, envelope, frame-scan, and word-cloud coverage
- [x] Documentation updated in `.agents/memory/data-sources-and-limitations.md` and `.agents/docs/architecture.md`
- [x] L0 formatting and L1 lint pass on changed files
