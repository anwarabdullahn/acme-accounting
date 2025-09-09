# Reports Performance Improvement Plan

## Summary
Speed up reports by eliminating blocking I/O, reducing duplicate work, and making the GET endpoint non-blocking. We’ll compute all report files in a single streamed pass over input CSVs and expose clearer progress states.

- Target endpoints: `GET /api/v1/reports`, `GET /api/v1/reports`
- Affected files: `src/reports/reports.controller.ts`, `src/reports/reports.service.ts`
- Key outcomes: near-zero request latency for GET, single-pass processing, async/streaming FS, concurrency guard, clearer state reporting

## Current Pain Points
- Blocking I/O: `fs.readdirSync/readFileSync/writeFileSync` block the Node event loop.
- Triple scanning: Each report scans `tmp/` and re-reads files independently.
- Request blocking: `GET` holds the connection until all work completes.
- Hot-path overhead: per-line `new Date(...)` and repeated `parseFloat(String(...))` calls.

## Goals
- Non-blocking `GET` returning quickly with `202` and background generation.
- Single-pass processing: read CSVs once, derive all outputs in the same iteration.
- Async, streaming I/O to avoid blocking and reduce memory.
- Concurrency guard to prevent overlapping runs.
- Clearer progress states and error visibility via `GET`.

## Non-Goals (for this iteration)
- No external job queue (e.g., BullMQ) or worker-threads.
- No schema or format changes to output CSVs.

## Plan & Progress
- [x] 0. Document plan (this file)
- [x] 1. Controller: make `GET` non-blocking with `@HttpCode(202)`; call a single `generateAll()` entrypoint
- [x] 2. Concurrency guard: prevent overlapping runs (e.g., `this.running` + try/finally)
- [x] 3. Single-pass pipeline: stream CSVs once and compute Accounts, Yearly, and FS in one pass
- [x] 4. Async I/O: replace sync FS with `fs/promises` + `createReadStream` + `readline`; ensure `out/` exists
- [x] 5. Micro-optimizations in hot loops: reuse parsed numbers, `year = date.slice(0,4)` (assuming ISO), reduce object lookups
- [x] 6. States: expand to `{status, startedAt, finishedAt, durationSec, error?}`; keep `GET` backward-compatible
- [x] 7. Smoke tests: temporarily removed (will re-add if needed)
- [x] 8. Logging: concise start/finish/error logs for generation

## Implementation Outline
1) Controller (`src/reports/reports.controller.ts`)
- Change `GET` to return `202` immediately.
- Fire-and-forget: `void this.reportsService.generateAll().catch(/* log & set error state */)`.

2) Service (`src/reports/reports.service.ts`)
- Add `generateAll()` that:
  - Sets all states to `starting`, records timestamps; implements concurrency guard.
  - `await fs.promises.mkdir('out', { recursive: true })`.
  - `const files = (await fs.promises.readdir('tmp')).filter(f => f.endsWith('.csv'))`.
  - For each file: stream lines with `fs.createReadStream` + `readline.createInterface`.
  - For each line: compute `delta = (parseFloat(debit)||0) - (parseFloat(credit)||0)` once and update:
    - Accounts: `accountBalances[account] += delta`.
    - Yearly: if `account==='Cash'` then `cashByYear[year] += delta`.
    - FS: if account in category map: `balances[account] += delta`.
  - Write outputs with `await fs.promises.writeFile(...)` for `accounts.csv`, `yearly.csv`, `fs.csv`.
  - Update states to `finished` with duration; on error, set `{ status: 'error', message }`.

3) Backward compatibility
- Keep `GET` response keys (`'accounts.csv'`, `'yearly.csv'`, `'fs.csv'`). Values become status strings or structured objects; if structure changes, include both string summary and detail fields.

## Acceptance Criteria
- `GET /api/v1/reports` responds in ~<50ms under idle load.
- `tmp/` is scanned once per run; no sync FS calls remain in reports code.
- No overlapping runs; concurrent `GET`s do not start duplicate work.
- Outputs match prior format and semantics for the same inputs.
- `GET /api/v1/reports` shows clear status and timing for each report.

## Risks & Mitigations
- Input format variance: if dates are not ISO, fall back to `new Date(date).getFullYear()` behind a try/catch or format check.
- Large files: streaming avoids OOM; ensure backpressure by line-by-line processing.
- Error visibility: set error state and log; do not fail the `GET` request.

## Rollout
- Implement steps 1–6 behind a small PR; verify locally with sample CSVs in `tmp/`.
- Optional: re-add smoke tests later if needed (step 7 removed per request); minimal logging (step 8) is in place.
- Share timings before/after using `performance.now()` measurements already present.

## Notes
- Step 7 smoke tests were removed per request; they can be restored from history if we decide to include them later.
