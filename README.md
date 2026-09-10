# pi-offload-router

Pi extension package for routing selected session-maintenance helper calls to a configured offload model.

## What it does

`pi-offload-router` lets Pi use a separate model for bounded helper work while your main Pi session keeps using the model you selected for coding.

Supported offload slots:

- compaction summaries for old conversation history;
- abandoned-branch summaries during `/tree` navigation;
- short session title generation;
- `HANDOFF.md` generation through `/handoff [focus]`.

Offload usage is tracked separately from Pi's main model usage and shown as an offload subtotal.

## Install

Install from GitHub as a Pi package, preferably pinned to a release tag:

```bash
pi install git:github.com/LunarNexus/pi-offload-router@v0.1.0
```

For local development or one-off testing:

```bash
pi -e ./index.ts
```

Pi packages and extensions run with your user permissions. Review source before installing packages from any third-party repository.

## Configuration

Runtime config lives outside the package so package updates do not overwrite user settings:

```text
~/.pi/agent/offload-router.json
```

On startup, if this runtime config is missing, the extension copies the packaged `offload-router.json` into that location. The config supports JSONC, so `//` and `/* ... */` comments are allowed.

Example config shape:

```json
{
  "enabled": true,
  "defaults": {
    "model": "lmstudio/LOADED",
    "taskTimeoutSeconds": 300,
    "queueTimeoutSeconds": 600,
    "maxTokens": 8192
  },
  "offloads": {
    "compaction": {
      "model": "default",
      "taskTimeoutSeconds": 600,
      "queueTimeoutSeconds": 600,
      "maxTokens": 16384
    },
    "branchSummary": {
      "model": "default"
    },
    "titleGeneration": {
      "model": "default"
    },
    "handoff": {
      "model": "default"
    }
  },
  "concurrency": {
    "maxInFlight": 1
  }
}
```

Each offload task is configured separately.

- `defaults` provides global explicit defaults.
- `compaction` keeps explicit timeout/token overrides.
- `branchSummary`, `titleGeneration`, and `handoff` inherit the global timeout/token settings unless you add overrides.
- `model` can be:
  - `"default"` to use `defaults.model`;
  - `"main"` to use Pi's current main session model;
  - a Pi model string like `"lmstudio/qwen3-4b-instruct"`.
- Effective values come from the shipped config plus explicit runtime overrides.

## Usage accounting

All offload usage is tracked by this plugin as an **offload subtotal**.

- Offload usage is shown in a compact footer/status line in Pi.
- `/offload status` shows the detailed subtotal and per-task breakdown.
- Offload usage is persisted in session custom entries, so reload/resume can rebuild the subtotal from session history and forked sessions carry forward the copied branch totals.
- Offload usage is intentionally kept separate from Pi's main footer totals so all offload actions follow the same accounting model.

## Commands

```text
/offload status
/offload on
/offload off
/offload model <model>
/offload slot <slot> <model|default|main>
/offload test [slot] [prompt]
/handoff [focus]
```

## Development checks

```bash
npm install
npm run typecheck
npm pack --dry-run
```

## References

- Pi package docs: https://pi.dev/docs/latest/packages
- Pi extension docs: https://pi.dev/docs/latest/extensions
