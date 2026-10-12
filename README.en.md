# dsh-memory

> **English | [中文](README.md)**

> A cross-session memory plugin for DSH (DeepSeek Harness): things you discussed are remembered automatically and carried into your next conversation — no need to re-explain context every time. Ships with a local memory-management panel where you can see and edit everything that was recorded.

- **Version**: 0.2.0 (see `package.json` for the source of truth)
- **Host**: DSH 0.2.0-rc.2 (installable on the `web` / `headless` / `desktop` profiles)
- **Data location**: everything stays local under `~/.dsh/memory/`; nothing is uploaded. The API and panel are loopback-only.
- **Requirements**: DSH installed (any profile); Node ≥ 18; **zero runtime dependencies** (no `npm install`).
- **License**: MIT (see [LICENSE](LICENSE))

## Contents

- [What is this](#what-is-this)
- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Data & privacy](#data--privacy)
- [Rollback & uninstall](#rollback--uninstall)
- [FAQ](#faq)
- [How it works](#how-it-works)
- [Observability & operations](#observability--operations)
- [Development & testing](#development--testing)
- [Known limitations](#known-limitations)

## What is this

Every new DSH session starts from scratch: your work context, the decision history of a project, the conventions you settled on last week — all of it has to be repeated. dsh-memory automates this:

1. **Automatic extraction** — at the end of each turn, the plugin decides whether anything is worth remembering (user preferences, project decisions, durable conclusions…) and, if so, writes it to local Markdown files.
2. **Automatic injection** — on every later turn, the recorded content is injected into the session as a plugin-owned user message (four segments: persona / global-memory index / project usage notes / project-memory index), so the model "remembers" you.
3. **Panel management** — a **Memory** section appears in DSH settings; from there you open the panel to browse / edit / delete / import-export memory entries, edit the persona and addressing, toggle each memory class, and inspect extraction-pipeline health.

Memory has two layers:

- **Global memory** (shared across all conversations): four conversational categories — work profile, user profile, current focus, recent activity (auto-rolling, keeping 30 entries / 30 days by default) — plus long-term memory;
- **Project memory** (isolated per workspace path): one directory per project, recording that project's decisions and state.

## Features

Every item below is backed by source (`lib/` and `web/`), described in terms of "what the user sees / gets".

### Automatic memory: extracted at turn end, injected next time

- **No manual work**: extraction is triggered after each turn completes normally (`turn/end` with `reason.kind === "completed"`); chit-chat and command-style one-liners (fewer than 3 words of user prose) are skipped, so no tokens are wasted.
- **Incremental**: the plugin keeps a per-session cursor and only processes newly completed turns; on failure the cursor does not advance, so the next turn retries automatically (no missed or duplicated writes).
- **Extraction follows the session route**: by default it reuses the model route of your current conversation; you can also pin a more stable `provider` / `model` in `cordis.patch.yml`.
- **Cross-session injection**: each later turn injects memory as a **plugin-owned user message** (delivered over the durable message channel by default, which works for **all** presets — including the `complete:true` minimal preset; `injectChannel: "section"` reverts to the old system-prompt injection). The message has four segments:

| Segment | What the model sees | Budget |
|---|---|---|
| Persona | addressing + your edited persona body | 400 lines / 16k chars |
| Global index | index of the four categories + long-term memory; recent-activity entries carry age and expiry | 40 lines per class, 120 lines / 12k chars total |
| Project usage notes | where the memory dir is, how to read the index, how to write/delete on request | fixed short text |
| Project index | the project's `MEMORY.md` index (the model Reads files on demand) | 200 lines / 25k chars, keeps newest on overflow |

- **Three-layer switches** (panel → Settings, effective next turn):

| Switch | Effect when off |
|---|---|
| Conversational memory (master) | injection and auto-extraction both stop; turns while off are not accumulated or backfilled |
| Project memory | project notes/index are no longer injected, project-class writes are filtered (count visible) |
| Global auto-extraction | no new global entries; existing ones still inject |

- **Anti-feedback**: injected messages carry `source.kind = "plugin:dsh-memory"`; the extraction side excludes them from "user prose", so the model never re-records injected memory into memory.

### Semantic recall (optional)

Off by default. Enable `recallEnabled` and configure an embedding endpoint (`embeddingBaseUrl` / `embeddingModel`) and each turn retrieves the most relevant entries for **your current question** (embedding cosine top-k), injected as a `<memory-recall>` block — without waiting for the model to Read the index. Embeddings are cached incrementally; only new/changed entries are re-embedded.

- **Off by default**: no endpoint configured means no external calls at all (memory text never leaves the machine); pointing at a local endpoint (e.g. ollama `http://127.0.0.1:11434/v1/embeddings`) also keeps it local.
- **Bring your own model (provider-agnostic)**: the plugin is tied to no specific embedding model or vendor — as long as your service exposes an OpenAI-compatible embedding endpoint (which almost every local deployment does), just set `embeddingBaseUrl` + `embeddingModel`. Any local model (nomic-embed-text, bge-m3, embed-model, …) works. `embeddingProvider` is only a display label and is optional.
- **Explicit degradation**: on timeout/error the turn simply recalls nothing (non-blocking, never fabricated), counted under `/state.recall`.

### Memory management panel

Entry point: DSH settings → **Memory** section → "Open memory management". Opening degrades gracefully (new window → embedded iframe → full page); the panel follows the host's light/dark theme. The settings block itself is a quick-action surface: master switch, "DSH's name" / "what to call me" inputs (debounced auto-save), status summary (N global entries · M projects), and a red bar with a "details" deep link on extraction failure.

![Memory management panel: category entries](docs/panel.png)

![Settings page: three-layer switches and extraction pipeline health](docs/panel-settings.png)

> Screenshots show the UI with sample data.

The panel (`/dsh-memory/panel/`, localhost only) includes:

- **Four category pages + long-term page**: entry cards (title / description / filename / updated time / body) supporting —
  - **browse & search**: instant filter on the long-term page (title / description / body); recent-activity entries carry an age badge;
  - **edit**: title (60 chars), description (60 chars), body (20000 chars); live char + UTF-8 byte counters;
  - **delete** (with confirmation) and **add entry**;
  - **source mode**: edit an entire category as one text blob (save = auto-backup then rebuild);
  - **reset**: clear a whole category (auto-backup first);
  - **import**: upload `.json` / `.md` (≤2MB) or paste; preview entries before committing (conflicts/renames flagged), auto-backup before write, batch-internal duplicate names get `-2` / `-3`.
- **Persona page**: split markdown editor + live preview, five presets (concise / professional / humorous / buddy / custom); "reset to default" restores the factory template (auto-backup first); 100KB cap. The persona supplements the official system prompt rather than replacing it.
- **Addressing page**: two inputs ("DSH's name" / "what to call me", 40 chars each), debounced auto-save, same data as the settings block.
- **Project memory page** (read-only): per-project entry count and last update; per-project JSON export.
- **Settings page**: the three switches; pipeline health card and extraction-model card; data card (**export all** JSON / **clear all memory**, auto-backup per class, persona & addressing preserved); backup list (latest 20, each restorable — restoring auto-backups the current state first).
- **Visible corruption**: if `settings.json` / `addressing.json` / `persona.md` fail to parse, a red bar appears ("parse failed, running with defaults"); toggling a switch or re-saving repairs it. Corrupt persona/addressing files are preserved as `*.corrupt-<ts>` before being overwritten.

### Pipeline health card and "retry extraction now"

- **Three-state light**: green = no recent failure (collapsed to one line); yellow = recent failure but auto-recovered; red = currently failing (with same-reason streak); gray pulse = extracting. While a streak is active it polls every 5s; the sidebar "Settings" item shows a red streak badge.
- **Failure buckets**: by reason (no-route / no-cwd / LLM call / parse / IO), showing only non-zero buckets.
- **Last 5 failures**: time / reason / model / error summary, plus the failure log path (`<storageRoot>/extraction-errors.log`).
- **Missed-range hint**: "turns after seq X are not yet recorded; they will be backfilled on recovery".
- **"Retry extraction now" button**: actually triggers one LLM extraction for sessions with un-extracted ranges (confirmation dialog notes the small token cost); 10s minimum interval, 409 while in flight.
- **"Copy diagnostics" button**: copies a state summary for pasting into an issue.
- **Extraction-model card**: honestly shows the extraction route (explicit `provider`/`model`, or "unspecified (follows session route)"), fallback config, the last route used, and the embedding model (for semantic recall).

### Failure resilience: retry, classification, on-disk trail

- **Cancellable backoff retry**: up to 3 attempts (incl. the first), exponential backoff from 500ms capped at 2s (jitter ±20%); honors upstream `Retry-After` when present. Aborts immediately on uninstall/exit.
- **Failure classification**: by kernel `failure.code` (EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT are retryable); AUTH / INVALID_REQUEST / QUOTA fail fast.
- **Fallback routes**: after the primary attempt chain fails unrecoverably, each `fallback` route is tried (full attempt chain each); success is recorded under `/state.fallbackUsed`.
- **On-disk failure log**: `<storageRoot>/extraction-errors.log`, always on, summary-only (time / pid / reason / route / error summary; **no conversation content**), rotated at 512KB.
- **Structural failures give up explicitly**: no-route / no-cwd, which cannot self-heal, are abandoned after 5 consecutive failures with an error log entry.

### Automatic backups

Every bulk destructive action has an undo: a full backup of `global/` + `settings.json` is written to `<storageRoot>/backups/<timestamp>/` before reset / import / restore / persona-reset / clear-all; the latest 20 are kept; half-written backups are marked "incomplete" and refuse restore; restoring first backups the current state (`pre-restore`).

## Quick start

### Install

This plugin is installed via **git** (`dsh plugin add <local clone path or git URL>`). It has zero runtime dependencies, so no `npm install` is needed.

```bash
dsh plugin --profile web add <path to your clone>   # or a git URL; profile: web / headless / desktop
dsh --profile web --dump-config                    # verify the entry is in the tree
```

All three profiles install as a **symlink** (`link:<clone path>`), so source edits need no copying; a running desktop instance still needs an HMR reload or restart to pick up new code (headless always loads the latest on start).

Installed = enabled: `cordis.patch.yml` sets `enabled: true` explicitly (the code default is off, fail-closed).

### Verify it works

1. Open a new session and chat a few turns with real content (full sentences, not single-word commands);
2. Check the disk: look for `MEMORY.md` and memory files under `~/.dsh/memory/projects/<slug>-<hash16>/memory/`, or entries under a global category dir (e.g. `~/.dsh/memory/global/work-profile/`);
3. Check injection: in a new turn, ask the model to recap "what do you remember about me / this project" — if it cites memory, injection works;
4. Or query the API: `GET /dsh-memory/api/state` (loopback) for `counts` and `extractionFailures` (should be all zero);
5. Open DSH settings → **Memory** → "Open memory management"; the pages should browse normally.

Note: changing entry config such as `cordis.patch.yml` on desktop / headless requires restarting that instance (web picks it up via HMR); the panel switches, addressing, and persona live in `~/.dsh/memory/settings.json` and take effect on the **next turn without a restart**.

## Configuration

cordis entry config (see `cordis.patch.yml`):

| Field | Default | Description |
|---|---|---|
| `enabled` | **false** (fail-closed) | Master switch; `cordis.patch.yml` sets `enabled: true`, so installing enables it visibly |
| `injectChannel` | **`"message"`** | Injection channel: `"message"` = durable user-message channel (default, all presets); `"section"` = legacy four-segment system-prompt injection (rollback) |
| `injectMaxChars` | 60000 | Total budget for message-channel injection (chars); overflow drops whole segments by priority, with a visible WARNING |
| `storageRoot` | `~/.dsh/memory` | Root for all memory (tests / migration; usually leave alone) |
| `provider` / `model` | empty (follow session) | Extraction route; must appear as a pair. Empty captures the current session route |
| `minUserWords` | 3 | Lower bound on prose word count for the skip condition |
| `timeoutMs` | 120000 | Per-extraction timeout |
| `maxOutputTokens` | 4096 | Extraction output cap |
| `maxIndexLines` / `maxIndexChars` | 200 / 25000 | Injection truncation budget |
| `maxManifestFiles` | 200 | Manifest file cap |
| `maxPromptChars` | 48000 | Incremental transcript truncation |
| `maxOps` | 20 | Max writes/deletes per turn |
| `recentKeepCount` / `recentKeepDays` | 30 / 30 | recent-activity rolling retention: max entries / max age (days) |
| `retryAttempts` | 3 | Total extraction attempts (incl. the first) |
| `retryBackoffMs` / `retryMaxDelayMs` | 500 / 2000 | Exponential backoff first step and cap (jitter ±20%; `Retry-After` honored and clamped) |
| `fallback` | `[]` (retry only) | Fallback routes `[{provider, model}]`, ≤3, deduped, must not collide with the primary |
| `embeddingModel` | empty | **Your** embedding model identifier. Required with `recallEnabled` — it is also the cache identity of the vector space (changing it re-embeds everything). Put the model name your endpoint serves, e.g. `nomic-embed-text`, `bge-m3`, `text-embedding-3-small` |
| `embeddingProvider` | empty | Optional display-only label for the panel; never used in calls and **not required to pair with `embeddingModel`** |
| `recallEnabled` | **false** | Semantic-recall master switch; enabling requires `embeddingBaseUrl` + `embeddingModel` (fail-loud otherwise) |
| `embeddingBaseUrl` | empty | Your embedding endpoint — **any OpenAI-compatible service, local or remote**: `POST <url>`, body `{model, input}`, returns `{data:[{embedding}]}` (also tolerates the `{embedding}` / `{embeddings}` shapes common in local servers). Only `http(s)` is accepted. Examples: ollama `http://127.0.0.1:11434/v1/embeddings`, LM Studio `http://127.0.0.1:1234/v1/embeddings`; vLLM / TEI / llama.cpp alike; remote e.g. `https://api.openai.com/v1/embeddings` |
| `embeddingApiKey` | empty | Endpoint auth (optional; adds `Authorization: Bearer`) |
| `recallTopK` / `recallMaxTokens` | 5 / 1200 | Max recalled entries per turn / recall-block token budget |
| `recallMinScore` | 0.35 | Cosine threshold ([0,1]) |
| `recallTimeoutMs` | 8000 | Per-embedding-call timeout (measured: a local CPU embedder ~0.6s standalone, but seconds under in-host contention) |

Unknown config keys throw (with a did-you-mean hint) — fail-loud, never silently swallowing a misconfiguration.

## Data & privacy

- **All data is local**: memory, settings, backups and logs live under `~/.dsh/memory/` (a dedicated dir; uninstalling does not touch other components);
- **Extraction uses the session route**: the extraction call reuses your current conversation's model channel (`ctx.llm.stream`); there is no separate cloud upload path;
- **The failure log contains no conversation content**: it records time / pid / reason / route / error summary only. The diagnostic log `debug.log` is enabled only when `DSH_MEMORY_DEBUG=1`;
- **API and panel are loopback-only**: every endpoint passes a loopback guard (127.0.0.1 / localhost, with Host and Origin checks).

Data layout:

```
~/.dsh/memory/
├── settings.json                          # three-layer switches (panel-editable, read each turn)
├── extraction-errors.log                  # extraction failure log (always on, rotated at 512KB)
├── debug.log                              # diagnostic log when DSH_MEMORY_DEBUG=1
├── embeddings.json                        # semantic-recall vector cache (created when recallEnabled)
├── global/                                # global memory
│   ├── persona.md                         # persona (starts from the factory template)
│   ├── addressing.json                    # {dshName, userAlias}
│   └── <category>/                        # work-profile / user-profile / current-focus / recent-activity / long-term
│       └── MEMORY.md + <kebab-name>.md
├── projects/<slug>-<hash16>/memory/       # project memory (isolated per workspace)
│   ├── MEMORY.md                          # index: - [Title](file.md) — one-line hook (≤150 chars)
│   └── <kebab-name>.md                    # entry: frontmatter name/description/metadata.type
└── backups/<ts>/                          # automatic backups (latest 20 kept)
```

The memory file format (frontmatter / index line / `[[name]]` links / cross-agent conventions) is in [FORMAT.md](FORMAT.md).

## Rollback & uninstall

1. **Disable without uninstalling**: set `enabled` to `false` in the profile's `cordis.patch.yml` (or bundle patch). Web picks it up via HMR; desktop/headless require a restart. To pause memory temporarily, just use the panel's master switch (next turn, no restart).
   - To revert **only the injection channel**: set `injectChannel` to `"section"`.
   - To disable **only semantic recall**: set `recallEnabled` to `false` (or remove it) — back to index-only, no embedding calls.
2. **Uninstall**: `dsh plugin --profile <name> remove dsh-memory`.
3. **Clear data**: delete `~/.dsh/memory/`.

## FAQ

**Q1: I changed the config / a switch and nothing happened.**
Two layers. Entry config in `cordis.patch.yml` (provider/model, budgets…) is HMR for web but needs a restart for desktop/headless. The panel switches, addressing and persona live in `~/.dsh/memory/settings.json`, read before each turn — effective next turn with no restart.

**Q2: The settings page shows "automatic extraction failed N times". What is it?**
The pipeline reporting trouble (typically a rate-limited free pool, HTTP 429). The plugin auto-retries (3 attempts with exponential backoff) and backfills each turn; if it stays down, click "Retry extraction now", or read `<storageRoot>/extraction-errors.log`, or pin a more stable `provider`/`model` for dsh-memory in `cordis.patch.yml`.

**Q3: I made a mistake editing an entry/persona and saved. Can I get it back?**
No — single-entry overwrite (save entry / save persona / rename) replaces the old text with no edit history (intentional). Batch destructive paths (reset / import / restore) are auto-backed-up; export first if you want an undo for single edits.

**Q4: Why wasn't what I just said recorded?**
Check in order: ① the turn had no ≥3-word user prose (e.g. a single-word command) — a noise-reduction design; ② you (or the model) wrote directly into the memory dir that turn; ③ extraction failed (red bar / health card); ④ a switch is off. In any case you can add an entry manually in the panel.

**Q5: Where does my conversation go?**
All memory data stays local under `~/.dsh/memory/`. Extraction itself runs over your current session's model route (the same channel you chat on; it sends an incremental transcript excerpt + existing memory index). The failure log records only error summaries, never conversation content. The API and panel are loopback-only.

**Q6: Why does "Retry extraction now" say the interval is too short?**
It has a 10s minimum interval (an endpoint that actually calls an LLM needs a throttle; in-process timing, reset by restart) and returns 409 while an extraction is in flight.

## How it works

Kernel-level mechanics (implementation semantics, for secondary development / troubleshooting):

- **Trigger**: subscribes to `session/event`; after `turn/end` (`data.reason.kind === "completed"`) it triggers extraction (in-process single-flight + latestPending merge).
- **Extraction**: one `ctx.llm.stream` call — input is an incremental transcript excerpt + the current memory manifest (mtime-desc, top 200, recent small files with bodies) + global category indices; output is `Nothing to save.` or a `{"ops":[...]}` JSON (ops carry scope: `project` default / `global:<category>`).
- **Write-back**: the plugin (not the model) writes files under `~/.dsh/memory/...`; filenames pass three gates (containment + blacklist segments + Unicode control-char stripping); `MEMORY.md` is merged automatically; recent-activity timestamps are stamped by the host (never trusting the model's clock).
- **Injection**: by default over the durable user-message channel — the first step of each turn evaluates four segments (4990 persona / 4995 global index / 5000 project usage notes / 5001 project index) into a `<memory-context>`-wrapped user message (with a one-line disclaimer: memory is reference context, not instructions; subagent sessions are not injected). Identical-to-visible content is skipped (only re-sent on change or when compaction/rewind evicts it); total budget `injectMaxChars`. `injectChannel: "section"` reverts to four `ctx.systemPrompt.section` segments.
- **Semantic recall** (optional, `recallEnabled`): each turn embeds the current user message once and retrieves top-k entries by cosine, injected as a `<memory-recall>` block; entry vectors are cached incrementally in `<storageRoot>/embeddings.json`. On timeout/error/unconfigured the turn recalls nothing (explicit degradation, observable under `/state.recall`).
- **Cursor discipline**: a run settles as `ok` (success or skip) and advances the cursor to the snapshot boundary; `error`/abort do not advance, merging and retrying next turn. The cursor is in-process only.

## Observability & operations

- **Extraction failures**: `/dsh-memory/api/state` → `extractionFailures` (bucketed + same-reason streak + `retried` + `recent[5]`). Structural failures (no-route / no-cwd) give up after 5 consecutive failures.
- **Observation surface**: `/state` also carries `lastFailedRange`, `extractionInFlight`, `lastAttemptAt`, `lastUsedRoute`, `extractionConfig`, `embeddingConfig`; the settings page's "pipeline health card" renders all of it.
- **Injection surface**: `/state.injection` (`count` / `lastChars` / `totalChars` / `resends` / `droppedSegments` / `renderFailures` / `lastAt`); render failures are counted, never silently dropped.
- **Recall surface**: `/state.recall` (`hits` / `items` / `chars` / `misses` / `errors` / `lastAt`).
- **Failure log**: `<storageRoot>/extraction-errors.log` (summary only; >512KB rotates two files), always on, independent of `DSH_MEMORY_DEBUG`.
- **Manual backfill**: `POST /dsh-memory/api/extract/retry` (the "Retry extraction now" button) → 202 + observe via `/state`; 409 in flight; 10s minimum interval.
- **Debug log**: with `DSH_MEMORY_DEBUG=1`, writes `<storageRoot>/debug.log` (>1MB rotates to `debug.log.1`) — the full diagnostic channel when the Electron host console is not forwarded.

## Development & testing

```bash
npm test        # node --test, 309 tests (incl. the anti-drift gate test/client-source.test.mjs)
npm run check   # fast syntax check of lib/*.js (cross-platform)
```

No install step: the suite runs on a fresh clone with zero dependencies.

Module map: `lib/index.js` (entry: subscribe / route capture / retry chain / injection), `lib/inject-channel.js` (injection block assembly / budget trimming / source heuristics), `lib/state.js` (extraction state machine), `lib/extract.js` (output parsing + scoped write-back), `lib/transcript.js` (transcript rendering & skip), `lib/manifest.js` / `lib/filename.js` (index & filename safety), `lib/global-store.js` (global CRUD / backup / restore), `lib/settings.js` (three-layer switches), `lib/metrics.js` (failure counting / classification / backoff / observation surfaces), `lib/errorlog.js` (failure log), `lib/api.js` + `lib/panel.js` + `lib/panel-logic.js` (REST API / panel serving / shared panel logic), `lib/client.js` (settings-page block), `web/panel.html` (single-file panel frontend).

## Known limitations

- **No single-entry edit history** (intentional): single-entry overwrite replaces the old text; batch paths are auto-backed-up.
- **Injection/recall blocks can accumulate** within a session (only compaction converges them; observable via `/state`).
- **Anti-feedback covers only own injections**: the extraction side excludes only `plugin:*` sources; host-official injections are still treated as ordinary user content.
- **`injectMaxChars` is a soft cap**: the appended truncation notice is not counted, so the final size may slightly exceed it.
- **Recall embeds the query every turn**: the first enable embeds all entries once; the endpoint is circuit-broken for 60s after consecutive failures.
- **markdown is the only source of truth**: no JSON source of truth.
- **Not on npm**: distributed via git.

See [ROADMAP.md](ROADMAP.md) for direction.
