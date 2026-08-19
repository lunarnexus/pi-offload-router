# pi-offload-router Foundation

## Purpose

`pi-offload-router` is intended to be a Pi extension package that routes bounded side tasks to cheaper, faster, or local models while leaving the main coding agent on the user's selected model.

The reference idea is Hermes Agent's auxiliary model system: separate model slots for side tasks. For this project, the accepted scope is narrower: Pi session compaction, branch summaries, title generation, and handoff generation. Pi does not appear to have a unified package for this yet, but Pi's extension hooks make the pattern feasible.

## Current decisions

- **Build as a Pi package/extension**, not a fork of Pi.
- **Start from an existing Pi plugin skeleton** copied from `~/workspace/pi-lmstudio`.
- **Prefer local/small models for bounded work**, especially via Pi-supported local endpoints such as LM Studio, llama.cpp, or OpenAI-compatible servers.
- **Keep the main agent model untouched** unless the user explicitly configures otherwise.
- **Use per-task routing slots** rather than one global auxiliary model.
- **Fail safe by default**:
  - compaction should fall back to Pi's normal compaction if aux summarization fails;
  - branch summaries should fall back to Pi's normal branch-summary behavior if aux summarization fails;
  - title generation should be non-critical and never block core agent work.
- **Ship a default config** with the package and create `~/.pi/agent/offload-router.json` from it on startup when the runtime config is missing.
- **Do not duplicate Orchestra**: this package is for small bounded helper calls, not subagents, task decomposition, research, planning, or review workflows.

## Candidate task slots

Accepted initial slots:

- `compaction` — custom session compaction summaries via `session_before_compact`.
- `branchSummary` — custom `/tree` branch summaries via `session_before_tree`.
- `titleGeneration` — generate concise session titles after early turns using Pi's public `ExtensionAPI.setSessionName(name)` API.
- `handoff` — generate `HANDOFF.md` through the integrated `/handoff [focus]` command.

Wishlist slots are tracked in `ROADMAP.md`.

## Constraints

- Pi extensions run with full local permissions, so config and logging must avoid leaking secrets or prompt contents unnecessarily.
- Side tasks can add latency; the extension needs timeouts and concurrency caps.
- Local models may be slow or have small context windows; large compaction jobs require explicit context-window checks or conservative chunking.
- Pi's existing provider/model registry should be reused where possible instead of inventing a separate provider system.

## Near-term MVP

The recommended MVP is:

1. `compaction` routed to a configured auxiliary model.
2. `branchSummary` routed to the same or another configured auxiliary model.
3. `titleGeneration` routed to a configured auxiliary model using Pi's public session-name API.
4. `handoff` routed to a configured auxiliary model through `/handoff [focus]`.
5. A diagnostic command such as `/offload status` to show config and test task slots.

This MVP reduces main-model spend on Pi session maintenance without taking over the main agent loop or duplicating Orchestra.
