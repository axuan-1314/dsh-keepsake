# dsh-keepsake

[![CI](https://github.com/axuan-1314/dsh-keepsake/actions/workflows/ci.yml/badge.svg)](https://github.com/axuan-1314/dsh-keepsake/actions/workflows/ci.yml)
[![tag](https://img.shields.io/github/v/tag/axuan-1314/dsh-keepsake)](https://github.com/axuan-1314/dsh-keepsake/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933.svg)](package.json)

> **English | [中文](README.md)**

> A cross-session memory plugin for DSH (DeepSeek Harness): things you discussed are remembered automatically and carried into your next conversation — no need to re-explain context every time. Ships with a local memory-management panel where you can see and edit everything that was recorded.

- **Version**: 0.5.0 (see `package.json` for the source of truth; see [CHANGELOG.md](CHANGELOG.md) for the change history)
- **Host**: DSH 0.2.0-rc.2 (installable on the `web` / `headless` / `desktop` profiles); `package.json` declares the DSH peer range, so the host runs a version-compatibility check at install/startup and asks for explicit confirmation before installing a mismatched build
- **Distribution**: GitHub repo tag tarball (plus local clone for development); upgrading is covered in [Upgrade](#upgrade) (DSH plugins do not auto-update)
- **Data location**: everything stays local under `~/.dsh/memory/`; nothing is uploaded. The API and panel are loopback-only.
- **Requirements**: DSH installed (any profile); Node ≥ 18; **zero runtime dependencies** (no `npm install`).
- **License**: MIT (see [LICENSE](LICENSE))

Design informed by the project-memory subsystems of comparable agents; v1 uses a single LLM call for simplified extraction.

![Memory management panel: category entries](docs/panel.png)

> Screenshots show the UI with sample data. Fastest path (full steps in [Quick start](#quick-start)):

```bash
dsh plugin --profile web add https://github.com/axuan-1314/dsh-keepsake/archive/refs/tags/v0.5.0.tar.gz
```

## Contents

- [What is this](#what-is-this)
- [Features](#features)
  - [Automatic memory: extracted at turn end, injected next time](#automatic-memory-extracted-at-turn-end-injected-next-time)
  - [Content redaction: secrets never reach memory or prompts](#content-redaction-secrets-never-reach-memory-or-prompts)
  - [Semantic recall (optional)](#semantic-recall-optional)
  - [Memory management panel](#memory-management-panel)
  - [Pipeline health card and "retry extraction now"](#pipeline-health-card-and-retry-extraction-now)
  - [Extraction run log and cross-restart resume](#extraction-run-log-and-cross-restart-resume)
  - [Extraction trigger gates: scoring gate, idle delay and per-session cap](#extraction-trigger-gates-scoring-gate-idle-delay-and-per-session-cap)
  - [Session backfill: recover failed ranges across restarts](#session-backfill-recover-failed-ranges-across-restarts)
  - [Memory upkeep: duplicate, stale and index-audit suggestions](#memory-upkeep-duplicate-stale-and-index-audit-suggestions)
  - [Failure resilience: retry, classification, on-disk trail](#failure-resilience-retry-classification-on-disk-trail)
  - [Automatic backups](#automatic-backups)
  - [Write reversibility: snapshots and trash](#write-reversibility-snapshots-and-trash)
- [Quick start](#quick-start)
  - [Install](#install)
  - [Upgrade](#upgrade)
  - [Verify it works](#verify-it-works)
- [Configuration](#configuration)
- [Data & privacy](#data--privacy)
- [Rollback & uninstall](#rollback--uninstall)
- [FAQ](#faq)
- [How it works](#how-it-works)
- [Observability & operations](#observability--operations)
- [Related projects in the ecosystem](#related-projects-in-the-ecosystem)
- [Development & testing](#development--testing)
- [Known limitations](#known-limitations)

## What is this

Every new DSH session starts from scratch: your work context, the decision history of a project, the conventions you settled on last week — all of it has to be repeated. dsh-keepsake automates this:

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
- **Cross-session injection**: each later turn injects memory as a **plugin-owned user message** (delivered over the durable message channel by default, which works for **all** presets — including the `complete:true` minimal preset; `injectChannel: "section"` reverts to the old system-prompt injection). Injection is bounded by a **dual budget**: the char-level `injectMaxChars` (default 30000) and the token-level `injectMaxTokens` (default **16000**, CJK-aware estimate; 0 = disable the token budget, char budget only) — both caps apply at once, dropping whole segments by priority on overflow. The message has four segments:

| Segment | What the model sees | Budget |
|---|---|---|
| Persona | addressing + your edited persona body | 400 lines / 16k chars |
| Global index | index of the four categories + long-term memory; recent-activity entries carry age and expiry | 22 lines per class (keeps newest), 120 lines / 12k chars total |
| Project usage notes | where the memory dir is, how to read the index, how to write/delete on request | fixed short text |
| Project index | the project's `MEMORY.md` index (the model Reads files on demand) | 200 lines / 25k chars, keeps newest on overflow |

- **Three-layer switches** (panel → Settings, effective next turn):

| Switch | Effect when off |
|---|---|
| Conversational memory (master) | injection and auto-extraction both stop; turns while off are not accumulated or backfilled |
| Project memory | project notes/index are no longer injected, project-class writes are filtered (count visible) |
| Global auto-extraction | no new global entries; existing ones still inject |

- **Anti-feedback (machine-origin exclusion)**: injected messages carry `source.kind = "plugin:dsh-keepsake"`; the extraction side applies a unified machine-origin rule — messages injected by **any plugin** (not just this one), plus systematic messages such as instruction / summary / tool, are all excluded from "user prose" (they count neither toward the skip gate nor into the extraction input), so the model never re-records injected memory into memory. Genuine human messages (including those with no source, or `steer` / `followup` kinds) always count; the semantic-recall query text likewise takes only human messages.

### Content redaction: secrets never reach memory or prompts

Conversations occasionally contain API keys, tokens or internal addresses that should not be recorded. Redaction is on by default (`redactionEnabled`, default **true**) and intercepts at two points:

- **First pass (before the extraction prompt)**: the transcript excerpt is redacted before truncation, at four render points (user message / assistant reply / tool call / tool result). The order is deliberate — redact first, clip second — so a truncated-in-half secret cannot slip through the patterns. The model sees, and extraction runs on, redacted text.
- **Second pass (before write-back, defense in depth)**: extraction-produced write/delete operations pass another redaction before any memory file is written; only string content fields are processed — filenames, paths, entry ids and op kinds are untouched. The hit count lands in the run log's `redacted` field (written only when non-zero), visible in the panel's "recent extraction records".

The built-in list is **7 fixed patterns** (the list is fixed; user-supplied regexes are not supported — this keeps regex backtracking from ever stalling the host process):

1. Private key blocks: a whole `-----BEGIN ... PRIVATE KEY-----` … `-----END ... PRIVATE KEY-----` block;
2. Bearer / Basic / Token credentials in `Authorization` / `Proxy-Authorization` headers;
3. Standalone Bearer / Basic tokens (16+ characters);
4. Common vendor key shapes: `sk-` prefixed keys, GitHub PATs (`ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` / `github_pat_`), AWS access keys (`AKIA`), Slack tokens (`xox`), Google API keys (`AIza`), JWTs (three-segment `eyJ` form);
5. Credentials embedded in URLs: `scheme://user:EXAMPLE_PASSWORD@example.com@host` keeps the scheme and host, replacing only the userinfo;
6. Sensitive key-value assignments: values after `:` or `=` for keys like `password` / `secret` / `token` / `api_key` / `private_key` / `credentials`;
7. Private IPv4 addresses: `10.x.x.x` / `172.16-31.x.x` / `192.168.x.x`.

Matches are replaced with the placeholder `[redacted]`; running redaction on already-redacted text changes nothing (idempotent). Set `redactionEnabled: false` to turn it off entirely and revert to the old behavior. Known limits are in [Known limitations](#known-limitations).

### Semantic recall (optional)

Off by default. Enable `recallEnabled` and configure an embedding endpoint (`embeddingBaseUrl` / `embeddingModel`) and each turn retrieves the most relevant entries for **your current question** (embedding cosine top-k), injected as a `<memory-recall>` block — without waiting for the model to Read the index. Embeddings are cached incrementally; only new/changed entries are re-embedded.

- **Off by default**: no endpoint configured means no external calls at all (memory text never leaves the machine); pointing at a local endpoint (e.g. `http://127.0.0.1:1234/v1/embeddings`) also keeps it local.
- **Configure in the panel**: the Settings page has an **"Embedding service"** card where you set the endpoint / model / API key and press **"Test connection"**; it takes effect on the **next turn — no YAML edit, no restart** (panel config lives in `~/.dsh/memory/settings.json` and overrides entry config).
- **Test connection never forwards a stored key**: the saved API key is only ever sent to the endpoint it was configured for — if a "Test connection" request targets a different address, the stored key is not carried over (only a key supplied in that request is used).
- **Re-saving never wipes the stored key**: when saving the embedding config, leaving the key input empty **keeps the stored key** (no need to retype it just to change the endpoint/model); the **"Clear stored key"** button (shown only when a key is set) clears it explicitly; typing a new key overwrites it.
- **Bring your own model (provider-agnostic)**: the plugin is tied to no specific embedding model or vendor — as long as your service exposes an OpenAI-compatible embedding endpoint (which almost every local deployment does), just set `embeddingBaseUrl` + `embeddingModel`. Any local model (EmbeddingGemma, bge-m3, …) works. `embeddingProvider` is only a display label and is optional.
- **Explicit degradation**: on timeout/error the turn simply recalls nothing (non-blocking, never fabricated), counted under `/state.recall`.

### Memory management panel

Entry point: DSH settings → **Memory** section (the Memory block on the DSH settings page, referred to below as the settings block) → "Open memory management". Opening degrades gracefully (new window → embedded iframe → full page); the panel follows the host's light/dark theme. The settings block itself is a quick-action surface: master switch, "DSH's name" / "what to call me" inputs (debounced auto-save), status summary (N global entries · M projects), and a red bar with a "details" deep link on extraction failure.

![Settings page: three-layer switches and extraction pipeline health](docs/panel-settings.png)

> Screenshots show the UI with sample data. The entry-management view of the panel is the screenshot at the top of this file.

The panel (`/dsh-keepsake/panel/`, localhost only) includes:

- **Four category pages + long-term page**: entry cards (title / description / filename / updated time / body) supporting —
  - **browse & search**: every category page and the long-term page have instant search (title / description / body filtering, 50 entries per page); recent-activity entries carry an age badge;
  - **edit**: title (60 chars), description (60 chars), body (20000 chars); live char + UTF-8 byte counters;
  - **delete** (with confirmation) and **add entry**;
  - **source mode**: edit an entire category as one text blob (save = auto-backup then rebuild);
  - **reset**: clear a whole category (auto-backup first);
  - **import**: upload `.json` / `.md` (≤2MB) or paste; preview entries before committing (conflicts/renames flagged), auto-backup before write, batch-internal duplicate names get `-2` / `-3`.
- **Persona page**: split markdown editor + live preview, five presets (concise / professional / humorous / buddy / custom); "reset to default" restores the factory template (auto-backup first); 100KB cap. The persona supplements the official system prompt rather than replacing it.
- **Addressing page**: two inputs ("DSH's name" / "what to call me", 40 chars each), debounced auto-save, same data as the settings block.
- **Project memory page** (read-only): per-project entry count and last update; per-project JSON export.
- **Trash page / Snapshots page** (see [Write reversibility](#write-reversibility-snapshots-and-trash)): deleted entries and pre-batch archives, restorable per entry or per file.
- **Settings page**: the three switches; pipeline health card (with the backfill area, see [Session backfill](#session-backfill-recover-failed-ranges-across-restarts)) and extraction-model card; the **Memory upkeep** card (see [Memory upkeep](#memory-upkeep-duplicate-stale-and-index-audit-suggestions)); a **retention policy** card (trash retention days / snapshot count / recent-activity retention days, effective next turn); data card (**export all** JSON / **clear all memory**, auto-backup per class, persona & addressing preserved); backup list (latest 20, each restorable — restoring auto-backups the current state first).
- **Visible corruption**: if `settings.json` / `addressing.json` / `persona.md` fail to parse, a red bar appears ("parse failed, running with defaults"); toggling a switch or re-saving repairs it. Corrupt files are preserved as `*.corrupt-<ts>` before being overwritten. A corrupt `settings.json` is preserved (renamed to `settings.json.corrupt-<ts>`) and then recovered from the shadow file `settings.last-good.json` (refreshed on every successful write), restoring your switch choices — it only falls back to defaults when no shadow is available, not by discarding your settings outright. When individual settings values are invalid and coerced to defaults, a yellow bar lists the field names ("N settings values were invalid and reset to defaults", from `/state.settingsDiagnostics.coercedFields`); re-saving the settings fixes it.

### Pipeline health card and "retry extraction now"

- **Three-state light**: green = no recent failure (collapsed to one line); yellow = recent failure but auto-recovered; red = currently failing (with same-reason streak); gray pulse = extracting. While a streak is active it polls every 5s; the sidebar "Settings" item shows a red streak badge.
- **Failure buckets**: by reason (no-route / no-cwd / LLM call / parse / IO), showing only non-zero buckets.
- **Last 5 failures**: time / reason / model / error summary, plus the failure log path (`<storageRoot>/extraction-errors.log`).
- **Missed-range hint**: "content after turn X is not yet recorded; it will be backfilled on recovery", with a backfill area to re-run ranges one by one (see [Session backfill](#session-backfill-recover-failed-ranges-across-restarts)).
- **"Retry extraction now" button**: actually triggers one LLM extraction for sessions with un-extracted ranges (confirmation dialog notes the small token cost); 10s minimum interval, 409 while in flight.
- **Injection budget usage**: the health card's injection summary shows the token-level usage "last ≈X tokens / cap Y" (when `injectMaxTokens` is 0 the token segment is hidden and it falls back to chars); the data source is `/state.injection`'s `lastTokens` / `totalTokens`.
- **"Copy diagnostics" button**: copies a state summary for pasting into an issue.
- **Extraction-model card**: honestly shows the extraction route (explicit `provider`/`model`, or "unspecified (follows session route)"), fallback config, the last route used, and the embedding model (for semantic recall).

### Extraction run log and cross-restart resume

The root cause behind "I chatted for a few turns but keepsake shows no feedback" was that success / zero-output / skip left no trace at all, failure details lived only in process memory (zeroed on every DSH restart), and failed ranges were lost permanently across restarts. This version adds a durable observation surface:

- **Extraction run log (durable surface)**: each settled extraction appends a line to `<storageRoot>/extraction-journal.jsonl` — `written` (how many written / deleted) / `zero-ops` (nothing worth recording, or ops that could not land) / `skipped` (direct write into memory, no usable user prose, master switch off, format read-only) / `failed` (the same reason names as the failure buckets) / `abandoned` (the same structural cause failed too many times, the range was explicitly abandoned and the cursor advanced without further retry). Appends are serialized to avoid concurrent corruption; past 2000 lines the file rotates keeping the last 1000; a write failure only logs a warning and never blocks extraction. It is not a source of truth — deleting it loses no memory (only the observation history and the resume boundary). See [FORMAT.md](FORMAT.md) section 7.
- **Panel "recent extraction records"**: the settings-page health card gains a collapsible list (time + seq range + result label), so "why wasn't that recorded" is answerable per turn. The "unrecovered range" red bar is now dual-sourced — after a restart it falls back to the on-disk unrecovered list instead of disappearing, and structurally abandoned ranges are also recorded on disk (the panel shows an "abandoned N ranges" hint).
- **Cross-restart resume**: the per-session extraction cursor is persisted alongside the run log, so after a DSH restart a reopened session **resumes from the last boundary** and failed ranges are no longer lost to a restart. **Trade-off**: a session that was never extracted still does not back-scan its history — extraction is driven by the session continuing to produce new turns, so an un-extracted history is picked up only when that session keeps chatting.

### Extraction trigger gates: scoring gate, idle delay and per-session cap

Extraction costs tokens, and the trigger side has three cost gates (all on by default, each with its own rollback switch):

- **Scoring gate** (`extractGateEnabled`, on by default; threshold `extractGateMinScore`, default **6**): before extraction the pending turns are scored — `score = user words + 2× distinct tool kinds + 2× human turns`. Below the threshold the LLM is not called at all and the run settles as `skipped/thin-evidence` (journal trail, cursor advances as usual). Word counts reuse the existing prose metric (space-separated words + one word per 2 CJK characters); sessions with tool calls or multiple human turns pass easily, while thin chit-chat turns no longer waste an LLM call.
- **Idle delay** (`extractIdleDelayMs`, default **3000** ms; 0 = extract immediately): after a turn completes the run waits 3 idle seconds — turns completing meanwhile merge into the same batch, so a burst of rapid turns triggers a single extraction. The timer is fixed-time rather than sliding, so it still fires during continuous conversation; pending extractions are **flushed immediately** on session disposal / plugin shutdown (joining the existing bounded drain), never dropped.
- **Per-session cap** (`extractMaxRunsPerSession`, default **50**; 0 = unlimited): once a session's automatic extraction runs hit the cap, further triggers settle as `skipped/session-cap` with the cursor advanced and the LLM is not called — pathological loop turns cannot burn money forever. The cap applies to the automatic pipeline only; manual backfill from the panel is not limited.

### Session backfill: recover failed ranges across restarts

v0.4.1 made failed ranges **visible** across restarts (the run log persists them); v0.4.2 makes them **recoverable**:

- **Panel "backfill" area**: the settings-page health card embeds a backfill list of unrecovered / abandoned extraction ranges (time + seq range + result label), each with a per-item "backfill" action. The list comes from the extraction run log and survives restarts.
- **Automatic sweep** (`autoRecoverEnabled`, on by default): beyond the manual button, failed ranges are also backfilled automatically at three trigger points — ① session disposal (`session/disposed`, that session only); ② after each turn completes (`turn/end`, a global sweep); ③ a few seconds after plugin load (a startup sweep, closing the cross-restart loop). Rules:
  - only **unrecovered failed ranges** (kind=failed) are auto-backfilled; explicitly abandoned ranges (kind=abandoned) are never retried automatically — "abandoned" means abandoned;
  - two automatic attempts on the same range are separated by a cooldown (`autoRecoverCooldownMs`, default **300000** ms = 5 minutes), so ranges the host cannot read back are not re-read at every trigger;
  - the automatic sweep shares the same single-flight lock as the manual button (one backfill at a time), so manual and automatic are naturally mutually exclusive;
  - without host session persistence the automatic sweep stays silent (a missing capability is not a failure; the manual button honestly returns 503 in that case).
- **Prerequisite and honest degradation**: reading a session back requires the host to provide its session-persistence service (built into the local host since 0.2.0-rc.2). On older hosts without it, the panel says so plainly and the API returns 503 (`E_HOST_UNSUPPORTED`) — it never pretends a backfill happened.
- **Range discipline**: a backfill range must lie **entirely within the readable range of the session**; anything beyond it (including the tail cut off by the per-session event cap on very large sessions) is explicitly refused and stays on the list — un-read content is never accounted as backfilled.
- **Async and observable**: `POST /api/sessions/recover` returns 202 and runs in the background (one backfill at a time; 409 while one is in flight); progress is observable under `/state.recover` (`inFlight` / `lastAt` / `lastOutcome` / `lastSessionId` / `autoEnabled` / `autoAttempts` / `lastAutoAt` / `lastAutoTrigger`). The list itself is `GET /api/sessions/pending`.

### Memory upkeep: duplicate, stale and index-audit suggestions

The settings page gains a **Memory upkeep** card. It only suggests; it never changes your memory on its own:

- **Duplicate suggestions**: pairs of entries with highly overlapping bodies, the same name across categories, or near-identical titles with overlapping bodies — each with a similarity score and the reason. Advisory only; which one to keep is your call, nothing is auto-merged.
- **Stale reminders**: entries not updated for a default of 90 days. Entries whose modification time is missing are honestly listed as "age unknown", never faked as 0 days.
- **Index health and "repair index"**: audits each `MEMORY.md` index against the disk (dangling lines pointing at missing files, unlisted entry files, empty categories). Repairing only adds/removes index lines and **never deletes entry files**; the index text is archived to a snapshot before any change (recoverable from the **Snapshots** page), and if that archive fails the repair is refused.
- **Endpoints**: `GET /api/maintenance/suggestions` (the suggestion list) and `POST /api/maintenance/repair-index` (the response's `fixed` is the array of applied actions, with `fixedCount` and `unchanged`).

### Failure resilience: retry, classification, on-disk trail

- **Cancellable backoff retry**: up to 3 attempts (incl. the first), exponential backoff from 500ms capped at 2s (jitter ±20%); honors upstream `Retry-After` when present. Aborts immediately on uninstall/exit.
- **Failure classification**: by kernel `failure.code` (EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT are retryable); AUTH / INVALID_REQUEST / QUOTA fail fast.
- **Fallback routes**: after the primary attempt chain fails unrecoverably, each `fallback` route is tried (full attempt chain each); success is recorded under `/state.fallbackUsed`.
- **On-disk failure log**: `<storageRoot>/extraction-errors.log`, always on, summary-only (time / pid / reason / route / error summary; **no conversation content**), rotated at 512KB.
- **Structural failures give up explicitly**: no-route / no-cwd, which cannot self-heal, are abandoned after 5 consecutive failures with an error log entry.
- **Per-item fault tolerance**: a malformed operation in the model's output is skipped on its own (good entries are still written); a single IO failure is isolated and reported without blocking the rest of the batch.

### Automatic backups

Every bulk destructive action has an undo:

- **Automatic full backup**: before a category reset / confirmed import / restore / persona reset / clear-all, the current global memory (`global/`, incl. persona & addressing) + `settings.json` + project memory (`projects/`) are backed up in full to `<storageRoot>/backups/<timestamp>/`;
- **Latest 20 kept**, so backups cannot grow unbounded;
- **Half-written backups are visible and refuse restore**: backups land in two stages (first `complete: false`, flipped to `true` when done), and an interrupted one is marked "incomplete" and refuses restore;
- **Restoring has its own undo**: the current state is backed up once more (`pre-restore`) before a restore, and if the restore fails midway the response carries that backup id so you can recover.

### Write reversibility: snapshots and trash

Writes from automatic extraction are not irreversible — the project side and the global side each leave a way back, visible and rollback-able in the panel:

- **Pre-batch snapshots (project side)**: before a batch overwrites or deletes existing entries, the old text is archived to `backups/surgical/<batchId>/` (latest `surgicalKeep`, default 30 batches). The panel's **Snapshots** page can restore **a whole batch** or **a single file**; the index (`MEMORY.md`) is reconciled afterwards.
- **Trash (deferred delete)**: deletions are no longer hard-deleted — a copy lands in `trash/<entryId>/` first and the original is removed only after the copy is confirmed in place, kept for `trashKeepDays` (default 30 days). The panel's **Trash** page restores a whole entry or a single file, and can purge one entry, purge everything older than the retention window, or empty the trash (emptying = real deletion). This path covers both deletions produced by **automatic extraction** and the panel's manual **"delete entry"** (`DELETE /entry`), while **category reset** (`clearCategory`) and the **recent-activity rolling prune** (`pruneRecentActivity`) still delete outright and do not go through the trash (a category reset takes a full auto-backup first).
- **Write-then-verify (project and global side)**: after landing, the file is read back and its four frontmatter fields and body are validated; on failure the **old text is rolled back** (a pure addition with nothing to roll back has its dirty file removed and lands in trash), and on the project side the new file is kept as a specimen under the snapshot's `failed/` directory. The global write path also verifies on read-back.
- **Hard-fact guard (project side)**: if an overwrite drops an existing hard fact (numbers, version numbers, hex identifiers, byte sizes) it is logged and counted (`hardfactDrops`); set `hardfactPolicy` to `block` and that op is rolled back and counted as `hardfactBlocks` (kept separate from write-verification failures `verifyFailed`; default `warn`: alert only, no blocking). Honest about the detection limits: a drop is flagged only when a whole type disappears from the new text or is displaced by a near-identical value (a suspected transcription slip, like 269 → 267) — frontmatter, index lines and dynamic notes (dates / countdowns) are excluded from the comparison, and **a whole-line delete may go undetected when the body contains many numbers of the same type**; the warn / block semantics are unchanged.
- **Three write-path gates (project side)**: an overwrite (full replacement) only happens with a matching expected sha1 — if the op's `sha1` field does not match the current file the op is rejected (counted as `expectedSha1Mismatches`), so no overwrite is based on stale content; a "blind" write without the sha1 never replaces the old body — it **downgrades to an append** (old body kept, new content after a separator) instead of replacing the whole file; extraction takes a batch lock (`<storageRoot>/extract.lock`), and a lock conflict blocks destructive operations.
- **Snapshot before global overwrites**: before automatic extraction rewrites an existing global-memory entry, the old text is archived to `backups/surgical/`; if the snapshot fails the overwrite is skipped and the original text is left untouched (better to miss one update than to lose the old text). **Manual panel saves (entry edits) are archived the same way**: if the pre-save archive fails the save is refused outright (503, old text untouched), and a successful response carries a `preSaveSnapshotId` so the replaced old text can be recovered from the **Snapshots** page.
- **Restores keep a copy too**: before restoring from a snapshot / trash / full backup, existing conflicting files at the restore target are archived first. A **full-backup restore** (`restoreBackup`) renames the old data to `retired-*` then swaps the new copy in; if the swap fails it renames the old data back (**automatic rollback** — and if even that rename fails, the `retired-*` directory is kept for manual recovery). A **snapshot / trash restore** (`restoreSurgicalSnapshot` / `restoreTrash`), however, does **not** auto-rollback — it writes files in a loop and stops in place on failure without restoring the previous state; the pre-restore archive it left behind is still on disk, and the API's failure response carries a `preRestoreSnapshotId` plus a hint pointing to it, so you can recover the overwritten old versions **by hand**. Restore endpoints share the same batch lock as extraction write-back, so a restore never interleaves with writes.
- **Visible on the health card**: the "automatic extraction pipeline" card on the settings page gains a write-safety line (trash count / verify failures / hard-fact blocks / hard-fact alerts / blind-write downgrades / sha1 mismatches / lock conflicts / snapshot failures — shown only when non-zero); the sidebar also shows trash and snapshot counts. The data source `/state.safety` has ten fields: three on-disk values (`surgicalBackups` / `lastSnapshotAt` / `trashPending`, computed live per request) and seven in-process counters (`verifyFailed` / `hardfactDrops` / `hardfactBlocks` / `expectedSha1Mismatches` / `blindWriteDowngrades` / `lockConflicts` / `snapshotFailures`, **reset on restart**).

> The only source of truth is `*.md` and `MEMORY.md`: `backups/` and `trash/` are **copy directories that are safe to delete** (deleting them loses no current memory, only the ability to roll back). See [FORMAT.md](FORMAT.md) section 7.

The three write-safety settings live in `~/.dsh/memory/settings.json` (the same file as the three switches — **not** entry config; putting them in `cordis.patch.yml` is rejected). `surgicalKeep` / `trashKeepDays` and the recent-activity retention days `recentKeepDays` can be edited directly from the settings page's **retention policy** card (effective next turn); `hardfactPolicy` has no panel input yet, so edit the file by hand and it takes effect next turn:

| Setting | Default | Meaning |
|---|---|---|
| `surgicalKeep` | 30 | How many pre-batch snapshots to keep; older ones are pruned by the write path |
| `trashKeepDays` | 30 | How long trash entries are kept; expired ones are purged by the write path and the panel's "purge expired" |
| `hardfactPolicy` | `warn` | Hard-fact drop policy: `warn` = alert into the log only; `block` = roll back and count as `hardfactBlocks` |

Hand-edit value rules (the panel's `PUT /settings` uses the same semantics): keys not mentioned keep their current value; an explicitly invalid `surgicalKeep` / `trashKeepDays` (non-positive integer / negative / non-numeric) falls back to the default; an out-of-whitelist `hardfactPolicy` keeps the current value (a hand-corrupted file read back at startup falls to `warn`).


## Quick start

### Install

Pick one of two channels (**zero runtime dependencies**, no `npm install` at any point):

**① GitHub tag tarball (recommended)** — install straight from a repo tag, pinned to a version:

```bash
dsh plugin --profile web add https://github.com/axuan-1314/dsh-keepsake/archive/refs/tags/v0.5.0.tar.gz
# profile: web / headless / desktop
```

**② Local clone (development / self-use)** — source edits take effect live:

```bash
dsh plugin --profile web add <path to your clone>   # or a git URL
```

Verify the entry is in the tree: `dsh --profile web --dump-config`.

Installed = enabled: `cordis.patch.yml` sets `enabled: true` explicitly (the code default is off, fail-closed).

> To run new code after edits / a version change: **the web profile reloads via HMR; desktop / headless need the instance restarted** (restart the desktop app; headless loads the latest on every start). The local-clone channel is a `link:` symlink, so source edits need no reinstall.

### Upgrade

DSH's plugin manager **does not support automatic updates** (the official UI states: upgrading means uninstall then install the new version). So an upgrade is just re-running the install with the new version:

```bash
# tag tarball channel: upgrading = re-run with the target version (see Releases or CHANGELOG.md)
dsh plugin --profile web add https://github.com/axuan-1314/dsh-keepsake/archive/refs/tags/<new-version>.tar.gz
# local-clone channel: git pull; no reinstall needed (symlink takes effect)
```

- **Your data is unaffected by upgrades**: memory, switches, persona and backups all live under `~/.dsh/memory/` — **outside the plugin package directory** — so uninstall / reinstall never touches them (unless you delete that directory yourself). Keeping data separate from code is deliberate.
- **Restart after upgrading**: replacing the installed package requires a process restart to load the new JS modules (web profile can reload via HMR; restart the desktop app; headless picks it up on next start).
- **Back up before downgrading**: a `keepsake-format.json` marker in the data directory records the storage-format version (see [FORMAT.md](FORMAT.md)). The format version has not changed since v0.3.0 (`FORMAT_VERSION=1`), so going back from v0.4.0 to v0.2.x does **not** trip the gate — the older build can read and write the same data normally; what it lacks is the v0.4.0 write-safety surface (pre-batch snapshots / trash / `sha1` overwrite guard / write-then-verify), so its extraction overwrites replace files outright. Take a full backup before downgrading (the data card's "export all", or simply copy `~/.dsh/memory/`). The read-only gate itself remains: only when data was written by a plugin of a **newer format version** does the older version turn read-only (write endpoints return 503) with a visible warning, recovering once you upgrade.

### Verify it works

1. Open a new session and chat a few turns with real content (full sentences, not single-word commands);
2. Check the disk: look for `MEMORY.md` and memory files under `~/.dsh/memory/projects/<slug>-<hash16>/memory/`, or entries under a global category dir (e.g. `~/.dsh/memory/global/work-profile/`);
3. Check injection: in a new turn, ask the model to recap "what do you remember about me / this project" — if it cites memory, injection works;
4. Or query the API: `GET /dsh-keepsake/api/state` (loopback) for `counts` and `extractionFailures` (should be all zero);
5. Open DSH settings → **Memory** → "Open memory management"; the pages should browse normally.

Note: changing entry config such as `cordis.patch.yml` on desktop / headless requires restarting that instance (web picks it up via HMR); the panel switches, addressing, and persona live in `~/.dsh/memory/settings.json` and take effect on the **next turn without a restart**.

## Configuration

cordis entry config (see `cordis.patch.yml`):

| Field | Default | Description |
|---|---|---|
| `enabled` | **false** (fail-closed) | Master switch; `cordis.patch.yml` sets `enabled: true`, so installing enables it visibly |
| `injectChannel` | **`"message"`** | Injection channel: `"message"` = durable user-message channel (default, all presets); `"section"` = legacy four-segment system-prompt injection (rollback) |
| `injectMaxChars` | 30000 | **Total** budget for message-channel injection (**char** level): the recall block and the main block share it, and the main block yields to the recall block; overflow drops whole segments by priority, with a visible WARNING. Lowered from 60000 in v0.4.2 (the supersede / disclaimer lines add fixed overhead, and throttling favors smaller per-turn blocks — see [How it works](#how-it-works)); set it explicitly if you need a larger budget |
| `injectMaxTokens` | 16000 | **Token-level** total budget for message-channel injection (CJK-aware estimate; recall block included, main block yields; applies together with `injectMaxChars`, the stricter cap wins). **0 = disable the token budget**, reverting to the char-only rule. The estimate is an approximation (CJK chars ≈1.5 tokens each, others ≈0.25 tokens each), not exact tokenization |
| `redactionEnabled` | **true** | Content-redaction master switch (see [Content redaction](#content-redaction-secrets-never-reach-memory-or-prompts)): secret-like content in the extraction prompt and in write-back is replaced with `[redacted]`; **false = no redaction at all**, old behavior |
| `storageRoot` | `~/.dsh/memory` | Root for all memory (tests / migration; usually leave alone) |
| `provider` / `model` | empty (follow session) | Extraction call route; must appear as a pair, else an error. Empty auto-captures the current session route (`request/header` first, `assistant/message`'s `source` as fallback, the same session-title strategy) |
| `minUserWords` | 3 | Lower bound on prose word count for the skip condition |
| `extractGateEnabled` | **true** | Scoring-gate switch for extraction triggers (see [Extraction trigger gates](#extraction-trigger-gates-scoring-gate-idle-delay-and-per-session-cap)); **false = gate off**, thin turns are extracted as before (old behavior) |
| `extractGateMinScore` | 6 | Scoring-gate threshold: `score = user words + 2× distinct tool kinds + 2× human turns`; below it the run settles as `skipped/thin-evidence` (no LLM call, cursor still advances) |
| `extractIdleDelayMs` | 3000 | Extraction idle delay (ms): after a turn completes, wait before running so burst turns merge into one extraction; **0 = extract immediately** (old behavior). Subject to the maximum timer delay — values beyond it fail loudly at startup |
| `extractMaxRunsPerSession` | 50 | Per-session cap on automatic extraction runs: past the cap further triggers settle as `skipped/session-cap` with the cursor advanced (no LLM call); **0 = unlimited**. Applies to the automatic pipeline only; manual backfill is not limited |
| `autoRecoverEnabled` | **true** | Auto-backfill switch (see the "automatic sweep" of [Session backfill](#session-backfill-recover-failed-ranges-across-restarts)): failed ranges are swept at three trigger points — session disposal / turn completion / startup; **false = automatic backfill off**, only the panel's manual button remains. Stays silent when the host has no session persistence |
| `autoRecoverCooldownMs` | 300000 | Minimum interval (ms) between two automatic backfill attempts on the same range, so ranges the host cannot read back are not re-read repeatedly; subject to the maximum timer delay |
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
| `embeddingModel` | empty | **Your** embedding model identifier. Required with `recallEnabled` — it is also the cache identity of the vector space (changing it re-embeds everything). Put the model name your endpoint serves, e.g. `EmbeddingGemma`, `bge-m3`, `text-embedding-3-small` |
| `embeddingProvider` | empty | Optional display-only label for the panel; never used in calls and **not required to pair with `embeddingModel`** (e.g. `local` / `lmstudio`) |
| `recallEnabled` | **false** | Semantic-recall master switch; enabling requires `embeddingBaseUrl` + `embeddingModel` (fail-loud otherwise) |
| `embeddingBaseUrl` | empty | Your embedding endpoint — **any OpenAI-compatible service, local or remote**: `POST <url>`, body `{model, input}`, returns `{data:[{embedding}]}` (also tolerates the `{embedding}` / `{embeddings}` shapes common in local servers). Only `http(s)` is accepted. Examples: a local service at `http://127.0.0.1:1234/v1/embeddings`; vLLM / TEI / llama.cpp alike; remote e.g. `https://api.openai.com/v1/embeddings` |
| `embeddingApiKey` | empty | Endpoint auth (optional; adds `Authorization: Bearer`) |
| `recallTopK` / `recallMaxTokens` | 5 / 1200 | Max recalled entries per turn / recall-block token budget |
| `recallMinScore` | 0.35 | Cosine threshold ([0,1]) |
| `recallTimeoutMs` | 8000 | Per-embedding-call timeout (measured: a local CPU embedder ~0.6s standalone, but seconds under in-host contention) |
| `recallTotalBudgetMs` | 20000 | Overall time budget per turn's recall (ms). Embeddings may be requested in serial batches, so a per-request timeout (`recallTimeoutMs`) cannot bound the whole turn; this caps it. On overflow the turn recalls from what is already cached and resumes next turn |

Unknown config keys throw (with a did-you-mean hint) — fail-loud, never silently swallowing a misconfiguration.

## Data & privacy

- **All data is local**: memory, settings, backups and logs live under `~/.dsh/memory/` (a dedicated dir; uninstalling does not touch other components);
- **Extraction uses the session route**: the extraction call reuses your current conversation's model channel (`ctx.llm.stream`); there is no separate cloud upload path;
- **The failure log contains no conversation content**: it records time / pid / reason / route / error summary only. The diagnostic log `debug.log` is enabled only when `DSH_KEEPSAKE_DEBUG=1`;
- **API and panel are loopback-only**: every endpoint passes a loopback guard (127.0.0.1 / localhost, with Host and Origin checks).

Data layout:

```text
~/.dsh/memory/
├── keepsake-format.json                   # storage-format version marker (internal; see FORMAT.md section 8)
├── extract.lock                           # extraction/restore batch lock (self-managed, safe to delete)
├── extraction-journal.jsonl               # extraction run log (observation + resume boundary; not source of truth, safe to delete)
├── settings.json                          # three-layer switches + retention policy (panel-editable, read each turn)
├── settings.last-good.json                # settings shadow (refreshed on every successful write; source for recovery when settings.json is corrupt)
├── settings.corrupt                       # corruption flag (set when settings.json fails to parse, cleared once settings are re-saved; keeps the red bar visible)
├── settings.json.corrupt-<ts>             # preserved copy of a corrupt settings.json (renamed, original content never lost)
├── extraction-errors.log                  # extraction failure log (always on, rotated at 512KB)
├── debug.log                              # diagnostic log when DSH_KEEPSAKE_DEBUG=1
├── embeddings.json                        # semantic-recall vector cache (created when recallEnabled)
├── global/                                # global memory
│   ├── persona.md                         # persona (starts from the factory template)
│   ├── addressing.json                    # {dshName, userAlias}
│   └── <category>/                        # work-profile / user-profile / current-focus / recent-activity / long-term
│       └── MEMORY.md + <kebab-name>.md
├── projects/<slug>-<hash16>/memory/       # project memory (isolated per workspace)
│   ├── MEMORY.md                          # index: - [Title](file.md) — one-line hook (≤150 chars)
│   └── <kebab-name>.md                    # entry: frontmatter name/description/metadata.type
├── backups/<ts>/                          # automatic backups (latest 20 kept)
│   └── surgical/<batchId>/                # pre-batch snapshots: old text before overwrite/delete (latest 30 kept)
└── trash/<entryId>/                       # trash: originals of deleted entries (kept 30 days by default)
```

- `keepsake-format.json` / `extract.lock` / `extraction-journal.jsonl` are all **self-managed, non-source-of-truth files that are safe to delete** (restamped if missing / rebuilt next batch / restarted afresh respectively); the only source of truth is `*.md` and `MEMORY.md` — see [FORMAT.md](FORMAT.md) sections 7 and 8.

- `slug`: a sanitized workspace basename (lowercased, `[^a-z0-9._-]+` → `-`, truncated to 48, falling back to `project` when empty);
- `hash16`: the first 16 hex chars of the sha256 of the absolute path (win32 lowercased);
- the memory file format (frontmatter / index line / `[[name]]` links / cross-agent conventions) is in [FORMAT.md](FORMAT.md).

## Rollback & uninstall

1. **Disable without uninstalling**: set `enabled` to `false` in the profile's `cordis.patch.yml` (or bundle patch). Web picks it up via HMR; desktop/headless require a restart. To pause memory temporarily, just use the panel's master switch (next turn, no restart).
   - To revert **only the injection channel**: set `injectChannel` to `"section"`.
   - To disable **only semantic recall**: set `recallEnabled` to `false` (or remove it) — back to index-only, no embedding calls.
2. **Uninstall**: `dsh plugin --profile <name> remove dsh-keepsake`.
3. **Clear data**: delete `~/.dsh/memory/`.

## FAQ

**Q1: I changed the config / a switch and nothing happened.**
Two layers. Entry config in `cordis.patch.yml` (provider/model, budgets…) is HMR for web but needs a restart for desktop/headless. The panel switches, addressing and persona live in `~/.dsh/memory/settings.json`, read before each turn — effective next turn with no restart.

**Q2: The settings page shows "automatic extraction failed N times". What is it?**
The pipeline reporting trouble (typically a rate-limited free pool, HTTP 429). The plugin auto-retries (3 attempts with exponential backoff) and backfills each turn; if it stays down, click "Retry extraction now", or read `<storageRoot>/extraction-errors.log`, or pin a more stable `provider`/`model` for dsh-keepsake in `cordis.patch.yml`.

**Q3: I made a mistake editing an entry/persona and saved. Can I get it back?**
It depends. **Saving a global entry** (edit or add/rename) **is archived**: the old text is snapshotted before the overwrite, and the successful response carries a `preSaveSnapshotId` so the replaced text can be recovered from the **Snapshots** page. **Saving the persona or the addressing** has **no archive** — the old text is replaced outright (only an already-corrupt file gets a `*.corrupt-<ts>` backup before being overwritten), so export first if you want an undo. **Deleting an entry moves it to the trash** (no longer a hard delete) and it can be restored from the **Trash** page; the trash keeps entries for 30 days by default, then auto-purges. Overwrites/deletes produced by **automatic extraction** likewise go through the [write-reversibility](#write-reversibility-snapshots-and-trash) snapshots and trash. Project memory is not hand-editable in the panel.

**Q4: Why wasn't what I just said recorded?**
Check in order: ① the turn had no ≥3-word user prose (e.g. a single-word command) — a noise-reduction design; ② you (or the model) wrote directly into the memory dir that turn; ③ extraction failed (red bar / health card); ④ a switch is off. In any case you can add an entry manually in the panel.

**Q5: Where does my conversation go?**
All memory data stays local under `~/.dsh/memory/`. Extraction itself runs over your current session's model route (the same channel you chat on; it sends an incremental transcript excerpt + existing memory index). The failure log records only error summaries, never conversation content. The API and panel are loopback-only.

**Q6: Why does "Retry extraction now" say the interval is too short?**
It has a 10s minimum interval (an endpoint that actually calls an LLM needs a throttle; in-process timing, reset by restart) and returns 409 while an extraction is in flight.

**Q7: What if the panel won't open?**
First confirm the plugin switch is on in DSH settings and the current profile mounts a webserver (a profile without one does not mount the panel). If opening from the settings block's "Open memory management" in a new window fails, the panel degrades automatically (new window → embedded iframe → full page); you can also visit `http://127.0.0.1:<port>/dsh-keepsake/panel/` directly — find the port in DSH's settings or startup log (the panel is loopback-only). If a parse-failed red bar shows, follow it to re-save the corresponding content, which rewrites and repairs it.

**Q8: I enabled semantic recall but it never hits. What now?**
Check in order: ① on the settings page's **"Embedding service"** card press **"Test connection"** to confirm the endpoint is reachable and the model name is right (a success prints the vector dimension); ② look at `/state.recall` — `hits`/`misses` (is it actually recalling at all?) and `errors` (endpoint or retrieval errors); ③ the threshold `recallMinScore` (cosine, default 0.35, not yet exposed as a settings-page control) is tuned in the config — too high filters out entries that should hit, so lower it a little. Note recall is governed by the three switches: turning off the conversational-memory master switch means zero injection and zero external calls, so recall stops too.

## How it works

Kernel-level mechanics (implementation semantics, for secondary development / troubleshooting):

- **Trigger**: subscribes to `session/event`; after `turn/end` (`data.reason.kind === "completed"`) it triggers extraction (in-process single-flight + latestPending merge: while a run is in flight, new triggers only update the latest boundary). After a turn completes the run first waits on the idle-delay timer (`extractIdleDelayMs`, fixed-time, merging bursts), then passes the scoring gate (`extractGateEnabled` / `extractGateMinScore`) and the per-session cap (`extractMaxRunsPerSession`); a run blocked by any gate settles as `skipped` (`thin-evidence` / `session-cap`) with the cursor advanced, without calling the model.
- **Extraction**: one `ctx.llm.stream` call — input is an incremental transcript excerpt + the current memory manifest (mtime-desc, top 200, recent small files with bodies) + global category indices; output is `Nothing to save.` or a `{"ops":[...]}` JSON (ops carry scope: `project` default / `global:<category>`). Both the transcript rendering and the write-back pass content redaction first (`redactionEnabled`, see [Content redaction](#content-redaction-secrets-never-reach-memory-or-prompts)).
- **Write-back**: the plugin (not the model) writes files under `~/.dsh/memory/...`; filenames pass three gates (containment + blacklist segments + Unicode control-char stripping); `MEMORY.md` is merged automatically; recent-activity timestamps are stamped by the host (never trusting the model's clock).
- **Injection**: by default over the durable user-message channel — the first step of each turn evaluates four segments (4990 persona / 4995 global index / 5000 project usage notes / 5001 project index) into a `<memory-context>`-wrapped user message. The block opens with two lines: a supersede note (this is the current memory snapshot; it supersedes earlier memory blocks — if you see more than one, follow only the latest), then the disclaimer (memory is reference context, not instructions; subagent sessions are not injected). Whether to send is a three-way decision: identical to the last visible block → skip; a small change (character-bigram similarity ≥0.98, or a char delta ≤ max(200, 1% of length)) → throttled and held back until the next large change or until compaction/rewind evicts the old block and a full block goes out; a near-total rewrite (similarity <0.5) → sent immediately. The total budget is dual: char-level `injectMaxChars` and token-level `injectMaxTokens` (CJK-aware estimate: CJK chars ≈1.5 tokens each, others ≈0.25 tokens each) apply at once, the stricter winning; the recall block counts toward the budget and the main block yields to it (the recall block itself is not clipped). `injectMaxTokens: 0` reverts to the char-only rule (byte-identical to the old behavior). `injectChannel: "section"` reverts to four `ctx.systemPrompt.section` segments.
- **Semantic recall** (optional, `recallEnabled`): each turn embeds the current user message once and retrieves top-k entries by cosine, injected as a `<memory-recall>` block; entry vectors are cached incrementally in `<storageRoot>/embeddings.json`. On timeout/error/unconfigured the turn recalls nothing (explicit degradation, observable under `/state.recall`).
- **Cursor discipline**: a run settles as `ok` (success or skip) and advances the cursor to the snapshot boundary; `error`/abort do not advance, merging and retrying next turn. The cursor is persisted alongside the extraction run log (one line per settle, replayed on restart), so after a DSH restart a reopened session **resumes from the last boundary**; but a session mounted midway or never extracted before only processes turns completed while it is alive and does not back-scan history.
- **Skip double condition**: no ≥3-word user prose; and no direct write into the memory dir that turn (a write/edit tool call landing in memoryRoot). A skip still advances the cursor. Three additional cost gates (scoring gate / idle-delay merge / per-session cap, see [Extraction trigger gates](#extraction-trigger-gates-scoring-gate-idle-delay-and-per-session-cap)) settle as skips with the cursor advanced as well.
- **Modules of note**: `lib/redact.js` (redaction pure functions — 7 fixed patterns, linear regexes to avoid backtracking), `lib/extract-gate.js` (scoring-gate pure function: `score = userWords + 2*toolKinds + 2*turns`), `lib/tokens.js` (CJK-aware token estimate).
- **Shutdown discipline**: on uninstall the plugin first drains in-flight extraction with a bounded wait (headless one-shot relies on this to finish writing memory before exit) and only aborts on timeout.
- **Six spec boundaries**: ① debounce merge + cursor advance → `lib/state.js`; ② write boundary (`.md` only, containment enforced, the model never touches the disk directly) → `lib/extract.js`; ③ filename safety → `lib/filename.js`; ④ injection budget → `lib/manifest.js`; ⑤ trigger threshold → `lib/transcript.js`; ⑥ anti-feedback (request-only extraction + the machine-origin rule: injections from any plugin and systematic instruction/summary/tool messages never count as user prose) → `lib/index.js` / `lib/transcript.js`.

## Observability & operations

- **Extraction failures**: `/dsh-keepsake/api/state` → `extractionFailures` (bucketed + same-reason streak + `retried` + `recent[5]`). Structural failures (no-route / no-cwd) give up after 5 consecutive failures.
- **Observation surface**: `/state` also carries `lastFailedRange`, `extractionInFlight`, `lastAttemptAt`, `lastUsedRoute`, `extractionConfig` (with fallback; plus five keys for the effective gate/redaction settings — `gateEnabled` / `gateMinScore` / `idleDelayMs` / `maxRunsPerSession` / `redactionEnabled`) and the top-level `injectMaxChars` / `injectMaxTokens` (the dual injection budgets), `embeddingConfig` (with the effective `baseUrl`); the settings page's "pipeline health card" renders all of it.
- **Extraction run-log surface (v0.4.1)**: `/state.extractionLog` — `runs` (latest 30 settled records) / `unrecovered` (failed ranges not later backfilled) / `abandoned` and `abandonedCount` (structurally failed ranges explicitly abandoned and no longer retried); its source is `<storageRoot>/extraction-journal.jsonl`, and settled rows carry the redaction hit count `redacted` (written only when non-zero). `settings.corrupt` (settings-file parse-failure marker), `recentKeepDays` (recent-activity retention days) and `extractionTimeoutMs` (per-extraction timeout) are observable in `/state` too.
- **Session-backfill surface (v0.4.2)**: `GET /dsh-keepsake/api/sessions/pending` (`hostSupported` + `items[]`, each carrying `sessionId` / `from` / `to` / `at` / `reason` / `kind` (failed / abandoned) / `sessionAvailable`); `POST /dsh-keepsake/api/sessions/recover` (202 async; 409 single-flight, 404 session missing, 503 host without session persistence); `/state.recover` (`inFlight` / `lastAt` / `lastOutcome` / `lastSessionId`, plus the v0.5.0 auto-backfill four keys `autoEnabled` / `autoAttempts` / `lastAutoAt` / `lastAutoTrigger` — `lastAutoTrigger` names the trigger point `disposed` / `turn/end` / `startup` / `manual`) observes progress.
- **Memory-upkeep surface (v0.4.2)**: `GET /dsh-keepsake/api/maintenance/suggestions` (`duplicates` / `stale` / `indexHealth` with `dangling` / `orphans` / `emptyCategories` / `counts` / `generatedAt`); `POST /dsh-keepsake/api/maintenance/repair-index` (`fixed` array of applied actions / `fixedCount` / `unchanged`).
- **Injection surface**: `/state.injection` (`count` / `lastChars` / `totalChars` / `resends` / `droppedSegments` / `renderFailures` / `lastAt`); v0.4.2 adds two same-source-replacement counters — `throttled` (changes held back this turn) and `superseded` (old blocks invalidated by the supersede note); v0.5.0 adds two token-level counters — `lastTokens` (last injection's token estimate) / `totalTokens` (cumulative, CJK-aware, see `lib/tokens.js`); the health card's injection summary shows them too (including the budget usage "last ≈X tokens / cap Y", falling back to chars when `injectMaxTokens` is 0). Render failures are counted, never silently dropped.
- **Recall surface**: `/state.recall` (`hits` / `items` / `chars` / `misses` / `errors` / `lastAt`).
- **Write-safety surface (v0.4.0)**: `/state.safety` carries ten fields: three on-disk values (`surgicalBackups` / `lastSnapshotAt` / `trashPending`, computed live per request) plus seven in-process counters (`verifyFailed` / `hardfactDrops` / `hardfactBlocks` / `expectedSha1Mismatches` / `blindWriteDowngrades` / `lockConflicts` / `snapshotFailures`, **reset on restart**); the pipeline health card gains a summary line, and the **Snapshots** / **Trash** pages let you inspect and restore.
- **Failure log**: `<storageRoot>/extraction-errors.log` (summary only; >512KB rotates two files), always on, independent of `DSH_KEEPSAKE_DEBUG`.
- **Manual backfill**: `POST /dsh-keepsake/api/extract/retry` (the "Retry extraction now" button) → 202 + observe via `/state`; 409 in flight; 10s minimum interval.
- **Visible corruption**: if `settings.json` / `addressing.json` / `persona.md` fail to parse, the plugin runs with defaults plus a `corrupt` marker and a red bar in the UI; a corrupt file is auto-backed-up as `*.corrupt-<ts>` before being overwritten. Coerced settings values are additionally exposed via `/state.settingsDiagnostics.coercedFields` (visible as the settings-page yellow bar).
- **Debug log**: with `DSH_KEEPSAKE_DEBUG=1`, writes `<storageRoot>/debug.log` (>1MB rotates to `debug.log.1`) — the full diagnostic channel when the Electron host console is not forwarded.
- **Backup policy**: a full backup to `backups/` is taken automatically before reset/import/restore, keeping the latest **20**; a half-written backup (no `complete` in its meta) is marked incomplete and refuses restore.

## Related projects in the ecosystem

Another DSH plugin by the same author. It is **independent** of this one and can be installed on its own:

- **[dsh-usage-stats](https://github.com/axuan-1314/dsh-usage-stats)** — a usage-statistics plugin for the DSH desktop app: a usage section in Settings (a five-cell summary bar / a 52-week token heatmap / today · 7-day · 30-day trend lines / a model-usage donut), stored as local JSONL with zero upload.

Both plugins only read and write their own local data directories; installing one or the other makes no difference to this plugin.

## Development & testing

```bash
npm test        # node --test, all unit tests (incl. the anti-drift gate test/client-source.test.mjs)
npm run check   # fast syntax check of lib/*.js (cross-platform)
```

No install step: the suite runs on a fresh clone with zero dependencies.

- **API smoke test**: `tools/api-walkthrough.sh` walks every REST endpoint against a throwaway test instance (refuses to run unless you set `WALKTHROUGH_CONFIRM=yes`; it clears that instance's memory data).
- **Contributing**: development setup, commit conventions and the PR flow are in [CONTRIBUTING.md](CONTRIBUTING.md); the change history is in [CHANGELOG.md](CHANGELOG.md); direction and the "deliberately not doing" list are in [ROADMAP.md](ROADMAP.md).

Module map: `lib/index.js` (entry: subscribe / route capture / retry chain / injection / auto-backfill), `lib/inject-channel.js` (injection block assembly / dual-budget trimming / source heuristics), `lib/state.js` (extraction state machine: single-flight / idle delay / per-session cap), `lib/extract.js` (output parsing + scoped write-back), `lib/transcript.js` (transcript rendering & skip, incl. the first redaction pass), `lib/redact.js` (redaction pure functions), `lib/extract-gate.js` (scoring-gate pure function), `lib/tokens.js` (CJK-aware token estimate), `lib/manifest.js` / `lib/filename.js` (index & filename safety), `lib/global-store.js` (global CRUD / backup / restore), `lib/settings.js` (three-layer switches), `lib/metrics.js` (failure counting / classification / backoff / observation surfaces), `lib/errorlog.js` (failure log), `lib/api.js` + `lib/panel.js` + `lib/panel-logic.js` (REST API / panel serving / shared panel logic), `lib/client.js` (settings-page block), `web/panel.html` (single-file panel frontend).

## Known limitations

- **Spec task-type filter not ported**: the upstream spec gates extraction eligibility by task type (interactive/fork/…); this plugin runs on all sessions and relies on the skip gates (no ≥3-word prose / direct-write turn) to suppress noise.
- **Relative-path `file_path` direct-write detection is conservative**: `transcript.js` resolves write/edit `file_path` against memoryRoot, so a relative path that lands inside the memory dir is treated as a direct-write turn and skips extraction — conservative (more skips, never misses a save).
- **Single LLM call** (not a subagent extraction loop, whose API surface is not established in DSH): when updating old memories the model only sees manifest descriptions + recent small files, not all old text; mitigated by attaching bodies (≤3000 chars × most recent 10 files).
- **Anti-feedback & retrieval**: the extraction call is request-only (no event appended); injected memory messages are tagged `source.kind = "plugin:dsh-keepsake"` and excluded on the extraction side — injected content appears in the session stream but is never saved back. Memory bodies are not auto-retrieved; the model reads them via the index (same as the upstream spec).
- **desktop/headless config changes need a restart** (see rollback section); no uniform hot reload.
- **Profiles without a webserver mount no API/panel**: the plugin's only hard dependencies are the extraction LLM and (in `section` mode) the system prompt; on a profile without a webserver (e.g. headless) it still loads and injects memory normally — only the REST API and panel are not mounted (`/dsh-keepsake/...` unreachable).
- **No per-edit history for persona/addressing; entry saves and deletes do have an undo**: PUT persona / PUT addressing still replace the old text outright — a bad paste overwrites it (only an already-corrupt file gets a `*.corrupt-<ts>` backup before being overwritten), so export first if you want an undo; but **PUT entry (saving an entry) snapshots the old text before overwriting** (the response carries `preSaveSnapshotId`, restorable from the **Snapshots** page), and **DELETE entry (deleting an entry) moves it to the trash** (kept 30 days by default, restorable from the **Trash** page). Batch destructive paths (reset/import/restore) also take a full auto-backup.
- **Extraction only processes turns completed while it is alive; it does not back-scan history** (intentional): a session mounted midway or never extracted is not proactively backfilled — it needs to keep producing new turns (cross-restart resume only covers sessions that were extracted before and whose boundary was persisted).
- **The global index reads all entries on every evaluation** (intentional): recent-activity rendering reads entry bodies (22-line budget only); fine at desktop scale; add mtime caching if the entry count explodes.
- **Injection blocks can accumulate within a session**: on large content changes a new injection message is sent and old blocks are not removed (committed history is immutable); only compaction converges them. Since v0.4.2 the supersede note makes the model follow only the latest block and change throttling reduces resend frequency, but the historical blocks still occupy context. Each block is bounded by the dual `injectMaxChars` / `injectMaxTokens` budgets; observable via `/state.injection.resends`.
- **The token estimate is a CJK-aware approximation, not exact tokenization**: `injectMaxTokens` and the recall-block budget use a codepoint-level estimate (CJK/fullwidth chars ≈1.5 tokens each, others ≈0.25 tokens each, rounded up); tokenizer differences across models skew the number — the budget is a guardrail against blowing up the context, not precise metering.
- **Redaction is regex best-effort**: the 7 built-in fixed patterns cover common secret shapes but are not exhaustive — non-standard key formats, credentials split across lines, or tokens cut apart by clipping can still slip through (redacting before clipping lowers the odds but not to zero). Regex replacement can also hurt body semantics, typically because **private IPv4 addresses are always replaced**: an address like `10.0.0.5` / `192.168.1.1` discussed as a subject (say, in a network-debugging note) becomes `[redacted]`. Two known deviations: key-value assignments only replace the first whitespace-delimited token of an unquoted value (quoted values are replaced whole), and a password containing @ inside URL userinfo is only cut at the first @. The pattern list is fixed and user-supplied regexes are not supported (guarding against regex backtracking), see [Content redaction](#content-redaction-secrets-never-reach-memory-or-prompts).
- **Redaction meets the hard-fact guard**: an old real key already on disk (written before redaction existed) compared against new text carrying the `[redacted]` placeholder will be counted as a hard-fact hex-identifier drop by the guard (a log/counter nuisance under the default `warn` policy, no data change; under `block` it may roll that op back). Such noise goes away as the old-key entries get updated normally.
- **`injectMaxChars` is the total injection budget (recall block included)**: with recall on, the main block yields to the recall block so the two together stay within it; the visible truncation notice is counted too (a slight overrun is possible only when the budget is too small to fit even the wrapper and notice). The token level (`injectMaxTokens`) mirrors this: the recall block counts toward the budget, the main block yields, and **the recall block itself is not clipped** — when the recall block alone exceeds the remaining total budget it goes out whole and only the main block is compressed (the same semantics as the existing char-level rule).
- **Machine-origin rule is deliberately narrow**: the extraction side excludes two `source.kind` families — injections from any plugin (`plugin:*`) and known systematic kinds (inject / instruction / summary / tool); everything else (including a missing source, bare `plugin`, or `steer` / `followup`) is treated as ordinary human content. Deliberate: a false negative (machine text treated as human) costs at most one extra extraction, a false positive (human text treated as machine) loses memory.
- **Throttling trade-off of same-source replacement**: small memory changes (similarity ≥0.98 or a tiny char delta) are held back and only go out with the next large change or after compaction — **an equal-length minor rewrite (e.g. a typo fix) may stay out of the model's view for a while**; that is the price of "sending less" under an append-only history, observable via `/state.injection.throttled`. A second trade-off: old blocks in host history cannot be retracted — the supersede note at the top of each block asks the model to follow only the latest one.
- **Backfill range limits**: a backfill range must lie entirely within the readable range of the session — reads of very large sessions are capped (truncation keeps the earlier part), so ranges in the truncated **tail** are explicitly refused and stay pending (never falsely accounted as backfilled); without host session persistence, backfill is unavailable altogether (stated plainly).
- **Echo suppression is tag-level**: the extraction input strips our own `<memory-context>` / `<memory-recall>` wrapper blocks; a "paraphrased" quote without the tags is not stripped — excluding the injected message itself relies on `source.kind`, but paraphrased text is indistinguishable.
- **Recall embeds the query every turn**: with recall enabled, the current user message is embedded each turn (per-call timeout `recallTimeoutMs`, overall per-turn budget `recallTotalBudgetMs`); entry vectors are incrementally cached, but **the first enable embeds all entries at once**. Off by default; no calls without a configured endpoint.
- **Recall blocks can accumulate within a session**: on recall changes a new block is sent and old blocks are not removed; only compaction converges them; observable via `/state.recall`. Recall blocks have **no** same-source replacement (the supersede note / throttling cover the main memory block only; hit-set dedup is their only convergence). The endpoint is circuit-broken for 60s after consecutive failures.

See [ROADMAP.md](ROADMAP.md) for direction.
