# pi-offload-router

Pi extension package for routing selected session-maintenance helper calls to cheap, small, or local models.

## Idea

Use an offload model for bounded helper work while the main Pi coding agent continues using the user's selected model.

Accepted initial features:

- summarize old conversation history during compaction;
- summarize abandoned branches during `/tree` navigation;
- generate short session titles using Pi's public session-name API;
- generate `HANDOFF.md` through an integrated `/handoff [focus]` command.

Wishlist items, including large tool-output compression and session-search summarization, are tracked in `ROADMAP.md`.

## Status

Early foundation/research scaffold. This repository was initialized from the `pi-lmstudio` Pi plugin skeleton; the copied implementation still needs to be replaced with offload-router behavior.

## Install

This package is intended to be installed from our Gitea site as a normal Pi package:

```bash
pi install git:<our-gitea-host>/<owner>/pi-offload-router@<ref>
```

## Configuration

Runtime config lives outside the package so package updates do not overwrite user settings:

```text
~/.pi/agent/offload-router.json
```

The package includes `offload-router.json` at the repo root. On startup, if this runtime config is missing, the extension should create it from the package default config.

Example config:

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

Each offload task is configured separately.

- `defaults` provides the global explicit defaults.
- `offloads.<name>` can override any field for that offload task.
- `model` can be:
  - `"default"` to use `defaults.model`
  - `"main"` to use Pi's current main session model
  - a Pi model string like `"lmstudio/qwen3-4b-instruct"`
- No hidden defaults live in code; effective values come from the shipped config plus explicit per-item overrides.

## Usage accounting

All offload usage is tracked by this plugin as an **offload subtotal**.

- Offload usage is shown in a compact footer/status line in Pi.
- `/offload status` shows the detailed subtotal and per-task breakdown.
- Offload usage is persisted in session custom entries, so reload/resume can rebuild the subtotal from session history and forked sessions carry forward the copied branch totals.
- Offload usage is intentionally kept separate from Pi's main footer totals so all offload actions follow the same accounting model.

## Commands

Planned commands:

```text
/offload status
/offload on
/offload off
/offload model <model>
/offload slot <slot> <model|default|main>
/offload test [slot] [prompt]
/handoff [focus]
```

## Initial MVP proposal

1. Implement config loading/writing and `/offload status`.
2. Integrate existing `/handoff [focus]` behavior and route it through the `handoff` slot.
3. Implement custom compaction using Pi's `session_before_compact` hook.
4. Implement branch summarization using `session_before_tree`.
5. Implement title generation using Pi's public `ExtensionAPI.setSessionName(name)` API.

## References

- Pi extensions docs: https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/docs/extensions.md
- Pi compaction docs: https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/docs/compaction.md
- Hermes auxiliary models docs: https://hermes-agent.nousresearch.com/docs/user-guide/configuration#auxiliary-models
- Hermes fallback/auxiliary task docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/fallback-providers#auxiliary-task-fallback
