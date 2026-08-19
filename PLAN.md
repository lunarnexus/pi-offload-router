# Plan

## Product goal

`pi-offload-router` is a Pi extension package installed from our Gitea site. It routes a small set of Pi session-maintenance helper calls to a configured offload model. The portable default uses Pi's current main model; users can switch the default to a cheap/local model with `/offload model <model>`.

It does **not** duplicate Orchestra. Orchestra owns subagents, task decomposition, research, planning, review, and delegated context-saving workflows.

## Package/install target

This repo should remain a normal Pi package:

```json
{
  "name": "pi-offload-router",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

Expected install shape:

```bash
pi install git:<our-gitea-host>/<owner>/pi-offload-router@<ref>
```

Runtime config lives outside the package so updates from Gitea do not overwrite user settings:

```text
~/.pi/agent/offload-router.json
```

The package includes `offload-router.json` at the repo root. On startup, if the runtime config file is missing, the extension should create it from the package default config.

## Accepted feature set

### 1. Compaction offload

Use Pi's `session_before_compact` hook to generate compaction summaries with the configured model for the `compaction` slot.

Failure behavior: fall back to Pi's default compaction.

### 2. Branch summary offload

Use Pi's `session_before_tree` hook to generate `/tree` branch summaries with the configured model for the `branchSummary` slot.

Failure behavior: fall back to Pi's default branch summary.

### 3. Session title generation

Generate concise session titles with the configured model for the `titleGeneration` slot.

Pi exposes `ExtensionAPI.setSessionName(name)` and `getSessionName()`, so title generation can set the session display name through the public extension API.

### 4. Handoff integration

Fold the existing `/handoff [focus]` extension into this package.

Behavior:

- command remains `/handoff [focus]`;
- writes `HANDOFF.md` at the project root;
- uses the configured model for the `handoff` slot;
- keeps overwrite confirmation;
- preserves the current concise handoff format.

## Model config

Keep model specification simple. A model is a single string, normally already including provider/model identity in Pi's model pattern format.

Examples:

```text
lmstudio/qwen3-4b-instruct
llama.cpp/qwen2.5-coder-7b
openai/gpt-4o-mini
google/gemini-2.5-flash
```

Do **not** split model config into separate `provider` and `model` fields.

Parsing rule: split on the first `/`. Left side is provider, right side is modelId (modelIds may contain slashes, e.g. OpenRouter's `google/gemini-2.5-flash`).

## Config shape

Initial config:

```json
{
  "enabled": true,
  "defaults": {
    "model": "main",
    "taskTimeoutSeconds": 120,
    "queueTimeoutSeconds": 300,
    "maxTokens": 4096
  },
  "offloads": {
    "compaction": {
      "model": "default",
      "taskTimeoutSeconds": 180,
      "queueTimeoutSeconds": 600,
      "maxTokens": 4096
    },
    "branchSummary": {
      "model": "default",
      "taskTimeoutSeconds": 120,
      "queueTimeoutSeconds": 300,
      "maxTokens": 4096
    },
    "titleGeneration": {
      "model": "default",
      "taskTimeoutSeconds": 20,
      "queueTimeoutSeconds": 30,
      "maxTokens": 80
    },
    "handoff": {
      "model": "default",
      "taskTimeoutSeconds": 180,
      "queueTimeoutSeconds": 900,
      "maxTokens": 4096
    }
  },
  "concurrency": {
    "maxInFlight": 1
  }
}
```

Rules:

- If the config file is missing, create it from the package default.
- `enabled: false` disables all plugin behavior except commands.
- `defaults` contains the explicit global defaults. There are no hidden fallback defaults in code.
- Each offload task may override any of:
  - `model`
  - `taskTimeoutSeconds`
  - `queueTimeoutSeconds`
  - `maxTokens`
- `model` may be either:
  - `"default"`, meaning use `defaults.model`;
  - `"main"`, meaning use Pi's currently selected main session model;
  - a model string like `"lmstudio/qwen3-4b-instruct"`.
- Queue timeout and task timeout are separate:
  - `queueTimeoutSeconds` limits how long an item waits to acquire the concurrency slot;
  - `taskTimeoutSeconds` limits the actual model request once it starts.
- Effective per-task values come from merging `defaults` with the specific offload config.

## Slash commands

Keep commands small and predictable.

### `/offload status`

Show:

- global enabled/disabled;
- config path;
- default model;
- each slot's configured value and resolved model;
- missing/unresolvable model warnings.

### `/offload on`

Enable plugin globally.

### `/offload off`

Disable plugin globally.

### `/offload model <model>`

Set `defaults.model`.

Example:

```text
/offload model lmstudio/qwen3-4b-instruct
```

### `/offload slot <slot> <model|default|main>`

Set `offloads.<slot>.model`.

Examples:

```text
/offload slot compaction default
/offload slot titleGeneration lmstudio/small-local
/offload slot branchSummary main
```

### `/offload test [slot] [prompt]`

Run a small completion against a slot's resolved model.

Examples:

```text
/offload test
/offload test handoff Say OK in five words or fewer.
```

### `/handoff [focus]`

Generate `HANDOFF.md` using the resolved `handoff` slot model.

## Usage accounting

All offload actions follow one accounting model:

- offload usage is tracked by this plugin as an offload subtotal;
- the plugin renders a compact Pi-style offload footer/status line;
- `/offload status` shows the subtotal plus per-task breakdown;
- offload usage is persisted in session custom entries so reload/resume can reconstruct it and forked sessions carry forward the copied branch totals;
- offload usage is intentionally kept separate from Pi's main footer totals so all offload actions are counted consistently.

## Verified Pi API notes

Checked against the installed `@earendil-works/pi-coding-agent` types:

- Model lookup: `ctx.modelRegistry.find(provider, modelId)` returns an exact match or undefined. There is no pattern matching in the registry.
- Completion: `ctx.modelRegistry.complete(model, context, options)` resolves provider auth internally; examples (`custom-compaction.ts`) use it without manual API-key handling.
- Completion options include `maxTokens`, `timeoutMs` (HTTP request timeout), `signal` (AbortSignal), `cacheRetention`, and `sessionId`. Per-task timeouts are therefore supported via `timeoutMs: task.taskTimeoutSeconds * 1000`.
- Main model reference: `ctx.model` is the current session model, used when a slot resolves to `"main"`.
- Session naming: `pi.setSessionName(name)` and `pi.getSessionName()` are public extension APIs; set only when the name is empty.
- Compaction/branch hooks match Pi's documented event contracts (`session_before_compact`, `session_before_tree`); returning no override lets Pi defaults run on failure.

## Implementation phases

### Phase 1 — Package skeleton and config

- Keep Pi package metadata compatible with Gitea install.
- Replace copied LM Studio-specific implementation with offload-router entry point.
- Implement config read/write at `~/.pi/agent/offload-router.json`.
- Auto-create the runtime config from the package default when missing.
- Implement model-string resolution: parse as described above and call `ctx.modelRegistry.find(provider, modelId)`. Use `getAvailable()` for status warnings.
- Implement `/offload status`, `/offload on`, `/offload off`, `/offload model`, and `/offload slot`.

### Phase 2 — Handoff integration

- Port the existing handoff extension into this package.
- Route generation through the resolved `handoff` slot model.
- Keep `/handoff [focus]` UX and `HANDOFF.md` output.

### Phase 3 — Compaction and branch summaries

- Implement `session_before_compact` with the resolved `compaction` slot model.
- Implement `session_before_tree` with the resolved `branchSummary` slot model.
- On errors or empty summaries, return no override so Pi defaults run.

### Phase 4 — Title generation

- Implement `titleGeneration` using Pi's public `ExtensionAPI.setSessionName(name)` API.
- Only set a generated title when `getSessionName()` is empty. Do not overwrite existing session names in MVP.

### Phase 5 — Polish

- Add `/offload test`.
- Add example config.
- Update README with Gitea install, config, and commands.
- Add smoke-test instructions.

## Wishlist

### Large tool-result compression

Potential future feature only. Not MVP because it can degrade exact information available to the main session.

### Session search summarization

Potential future feature only, if session search/retrieval becomes part of this package or a companion package.

## Out of scope

- Risk/approval classifier.
- Input preprocessing or prompt rewriting.
- Memory/notes extraction.
- Skill suggestion/review.
- Web extraction summarization.
- Vision pre-analysis.
- Goal judging.
- Task specification.
- Task decomposition.
- Profile/agent description.
- Memory query rewriting.
- Monitor/classifier workflows.
- TTS/audio tag insertion.
- MCP helper operations.
