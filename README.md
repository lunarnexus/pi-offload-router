# pi-offload-router

Use a cheaper model for Pi's housekeeping work.

Pi can spend a surprising amount of model time on side jobs: compacting long chats, summarizing branches, naming sessions, and writing handoff notes. `pi-offload-router` sends those jobs to the model you choose, so your main coding model can stay focused on the actual work.

Good fits:

- use a local LM Studio or Ollama model for summaries;
- use a cheaper cloud model for background chores;
- keep expensive models for coding, debugging, and review;
- see offload token usage separately from your main session usage.

## Install

From GitHub:

```bash
pi install git:github.com/LunarNexus/pi-offload-router@v0.1.0
```

Then restart Pi or run `/reload`.

For local development or one-off testing:

```bash
pi -e ./index.ts
```

Pi packages and extensions run with your user permissions. Review source before installing packages from any third-party repository.

## What gets routed?

`pi-offload-router` can route these Pi side jobs:

- `/compact` summaries for old conversation history;
- abandoned-branch summaries during `/tree` navigation;
- short session title generation;
- `HANDOFF.md` generation through `/handoff [focus]`.

If offloading is disabled or the configured model cannot be found, Pi keeps going without the offload result.

## Quick test

```text
/offload status
/offload test handoff Write one sentence about this session.
```

## Configuration

The first time Pi loads the extension, it creates:

```text
~/.pi/agent/offload-router.json
```

Edit that file to pick the model used for background jobs. Package updates will not overwrite it.

The config supports comments, so the generated file includes notes inline.

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

Model values can be:

- `"default"` to use `defaults.model`;
- `"main"` to use Pi's current main session model;
- a Pi model string like `"lmstudio/qwen3-4b-instruct"`.

## Where did the tokens go?

All offload usage is tracked as a separate subtotal.

- A compact footer/status line shows offload usage in Pi.
- `/offload status` shows totals and a per-job breakdown.
- Reloaded and forked sessions keep their offload totals through Pi session entries.
- Offload usage stays separate from Pi's main footer totals.

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

## Publishing to pi.dev/packages

The Pi package gallery lists packages published to npm with the `pi-package` keyword and a `pi` manifest in `package.json`.

Before publishing:

```bash
npm install
npm run typecheck
npm pack --dry-run
npm publish
```

After npm publishes the package, it should be installable with:

```bash
pi install npm:pi-offload-router
```

GitHub installs work now; npm publishing is what makes the package show up in the Pi gallery.

## Development checks

```bash
npm install
npm run typecheck
npm pack --dry-run
```

## References

- Pi package docs: https://pi.dev/docs/latest/packages
- Pi extension docs: https://pi.dev/docs/latest/extensions
