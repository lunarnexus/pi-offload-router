# Research Notes

## Question

Does a Pi plugin already exist that provides Hermes-style auxiliary model routing for side tasks?

## Current answer

No exact match was found in the prior search. There are adjacent Pi packages and general model routers, but no single Pi package was identified that exposes a focused auxiliary/offload registry for compaction, branch summaries, title generation, handoff generation, and related side tasks.

## Hermes reference pattern

Hermes Agent has a native auxiliary model system, configured per task. Documented task slots include:

- `vision` — image analysis and browser screenshots.
- `web_extract` — web page extraction/summarization.
- `compression` — context compression summaries.
- `approval` — smart command-approval classification.
- `title_generation` — session title summaries.
- `skills_hub` — skill search/discovery.
- `mcp` — helper model operations for MCP flows.
- `triage_specifier`, `kanban_decomposer`, `profile_describer` — Kanban/profile helper tasks.
- `background_review`, `curator`, `goal_judge` and other background/judging tasks.

Hermes task blocks generally support provider/model selection, custom base URLs, API keys, timeouts, reasoning effort, fallback chains, and concurrency caps.

Sources:

- https://github.com/NousResearch/hermes-agent
- https://hermes-agent.nousresearch.com/docs/user-guide/configuration#auxiliary-models
- https://hermes-agent.nousresearch.com/docs/user-guide/features/fallback-providers#auxiliary-task-fallback

## Pi capability evidence

Pi extensions can support this pattern through hooks and APIs:

- `session_before_compact` can replace default compaction with a custom summary.
- `session_before_tree` can replace branch summaries.
- `tool_result` can modify or summarize tool results before they enter the transcript.
- `tool_call` can block or mutate tool calls, enabling approval/risk gates.
- `input` and `before_agent_start` can transform input or inject context.
- `registerProvider` can add local/OpenAI-compatible providers.
- Pi already has llama.cpp router support and can use local models.

Local files previously reviewed:

- Pi README and extension docs under the installed `@earendil-works/pi-coding-agent` package.
- Pi compaction docs.
- Pi `examples/extensions/custom-compaction.ts`, which demonstrates one-task custom compaction using a separate model.

## Adjacent projects found

- **BitRouter** — general routing layer with Pi integration; routes LLM calls by loop/context rather than per named side task. Potentially useful architecture reference.
  - https://github.com/bitrouter/bitrouter
- **pi-zai-vision-route** — routes image/vision turns to a vision model, then restores text model. Single-task adjacent match.
  - https://github.com/hieusats/pi-zai-vision-route
- **pi-scheduled-router** — time-based provider/model switching. Adjacent but not side-task offloading.
  - https://github.com/eiei114/pi-scheduled-router
- **@bacnh85/pi-model-tools** — Pi model-family/tool repair utilities. Multi-model-aware, but not auxiliary routing.
  - https://github.com/bacnh85/pi-extensions/tree/main/pi-model-tools
- **pi-weighted-model-router** — weighted model pool routing. Adjacent but not per-task auxiliary routing.

## Gap

Pi has the hook surface for task-specific offloading, and examples demonstrate pieces of it, but the ecosystem appears to lack a focused auxiliary routing extension with:

- named task slots;
- per-task model string config;
- common model completion helper using Pi's model registry;
- fallback/timeouts/concurrency;
- safe defaults for compaction, branch summaries, title generation, and handoff generation.

## Follow-up research: implementation options

A targeted follow-up compared Hermes, BitRouter, Pi's custom compaction example, Pi extension hooks, and general model-router designs.

Key findings:

- **Hermes** validates the per-task slot architecture. Each auxiliary task has independent model/timeouts, and compaction/branch summaries/title generation/handoff can use different defaults.
- **BitRouter** validates loop-step/context routing and policy-lock ideas, but it is a broader router/gateway pattern and is too complex for this project.
- **Pi's custom compaction example** proves the critical implementation path: `session_before_compact` can call `ctx.modelRegistry.find(...)` and `ctx.modelRegistry.complete(...)`, then return a replacement compaction object.
- **Pi's extension API** has the necessary hooks for compaction and branch summary. The existing handoff extension proves the handoff behavior is feasible. Title generation can use the public `ExtensionAPI.setSessionName(name)` API.
- **General semantic routers** are interesting but add latency/training overhead and are not needed for structurally distinct side tasks.

Current scope decisions are in `FOUNDATION.md` and `ROADMAP.md`.

## Open research questions

- RESOLVED: `ctx.modelRegistry.find(provider, modelId)` is an exact match (no pattern support). `ctx.modelRegistry.complete(model, context, options)` resolves auth internally; options include `maxTokens`, `timeoutMs`, `signal`, `cacheRetention`, and `sessionId`. Model config strings parse by splitting on the first `/`.
- RESOLVED: session naming uses public `pi.setSessionName(name)` / `pi.getSessionName()`.
- Does BitRouter already provide enough routing control that this package should integrate with it later rather than compete?
- What minimum model capability/context window is needed for safe compaction?
- If large tool-output compression is revisited later, where should raw outputs be preserved?
