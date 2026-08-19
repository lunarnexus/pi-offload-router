# Roadmap

## Accepted MVP

1. **Custom compaction model**
   - Route Pi's native session compaction summaries to a configured cheap/local model.
   - Use Pi's `session_before_compact` hook.
   - Failure should fall back to Pi's default compaction behavior.

2. **Branch summary model**
   - Route `/tree` branch-abandon summaries to a configured cheap/local model.
   - Use Pi's `session_before_tree` hook.
   - Failure should fall back to Pi's default branch-summary behavior.

3. **Session title generation**
   - Generate short session names after the first meaningful exchange.
   - Keep this low-cost and non-critical.
   - Use Pi's public `ExtensionAPI.setSessionName(name)` API.

4. **Handoff generation**
   - Integrate the existing `/handoff [focus]` extension into this package.
   - Route handoff generation through the configured `handoff` slot.
   - Keep output as project-root `HANDOFF.md`.

## Wishlist / investigate later

1. **Large tool-result compression**
   - Potentially summarize oversized/noisy tool outputs before they bloat context.
   - This can degrade the exact information available to the main session, so it is not MVP.
   - Any future version must preserve recovery paths: command, exit code, first/last lines, exact errors, filenames, line numbers, and raw output access.

2. **Session search summarization**
   - If we add or integrate session search, use an auxiliary model to summarize matching old sessions.
   - This is only useful if retrieval/search becomes part of this package or a companion package.

## Rejected / out of scope

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

## Boundary with Orchestra

This package should not duplicate Orchestra. Orchestra owns subagents, task decomposition, research/planning/review workflows, and context-saving through delegated work.

`pi-offload-router` should stay focused on small bounded helper calls for Pi's own session maintenance and metadata generation.
