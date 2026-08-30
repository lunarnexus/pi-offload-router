import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path, { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { parse as parseJsonc } from "jsonc-parser";
import { calculateCost, uuidv7 } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

type NotifyLevel = "info" | "warning" | "error";
type SlotName = "compaction" | "branchSummary" | "titleGeneration" | "handoff";
type ModelSpecifier = "default" | "main" | string;
type PiModel = Model<Api>;

type OffloadDefaults = {
  model: string;
  taskTimeoutSeconds: number;
  queueTimeoutSeconds: number;
  maxTokens: number;
};

type OffloadTaskConfig = {
  model?: ModelSpecifier;
  taskTimeoutSeconds?: number;
  queueTimeoutSeconds?: number;
  maxTokens?: number;
};

type OffloadRouterConfig = {
  enabled: boolean;
  defaults: OffloadDefaults;
  offloads: Record<string, OffloadTaskConfig>;
  concurrency: { maxInFlight: number };
};

type ResolvedOffloadTask = {
  model: ModelSpecifier;
  taskTimeoutSeconds: number;
  queueTimeoutSeconds: number;
  maxTokens: number;
};

type UsageTotals = {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

type PersistedOffloadUsage = {
  slot: SlotName;
  usage: Usage;
};

type WidgetTheme = {
  fg(color: string, text: string): string;
};

type WidgetComponent = {
  render(width: number): string[];
  invalidate(): void;
};

type WidgetFactory = (_tui: unknown, theme: WidgetTheme) => WidgetComponent;

type ExtensionCtx = {
  hasUI: boolean;
  cwd: string;
  model?: PiModel;
  sessionManager: { getBranch(): SessionEntry[]; getEntries(): SessionEntry[] };
  modelRegistry: {
    find(provider: string, modelId: string): PiModel | undefined;
    getAvailable(): PiModel[];
    complete(model: PiModel, context: unknown, options?: Record<string, unknown>): Promise<AssistantMessage>;
  };
  ui: {
    notify(message: string, level?: NotifyLevel): void;
    confirm(title: string, message: string): Promise<boolean>;
    setStatus(key: string, value: string | undefined): void;
    setWidget(key: string, value: string[] | WidgetFactory | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
    theme?: { fg(color: string, text: string): string };
  };
  waitForIdle?: () => Promise<void>;
};

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "offload-router.json");
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(PACKAGE_ROOT, "offload-router.json");
const HANDOFF_FILE = "HANDOFF.md";
const OFFLOAD_USAGE_ENTRY_TYPE = "offload-router:usage";
const SLOT_NAMES: SlotName[] = ["compaction", "branchSummary", "titleGeneration", "handoff"];
const SLOT_SET = new Set<SlotName>(SLOT_NAMES);

const HANDOFF_SYSTEM_PROMPT = `You are a context handoff assistant. Read the serialized conversation history and create a self-contained HANDOFF.md document for another LLM or future session to continue the work.

Do NOT continue the conversation. Do NOT answer questions from the conversation. Only produce the handoff document.

Use this format:

# Handoff

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements, preferences, or constraints]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Data, examples, paths, commands, exact errors, or references needed to continue]

## Files
### Read
- [Paths read or inspected]

### Modified
- [Paths changed]

Keep it concise but complete. Preserve exact file paths, function names, command names, and error messages.`;

const COMPACTION_SYSTEM_PROMPT = `You are a conversation compaction assistant for a coding workflow. Produce a continuation-safe summary that preserves the exact technical context needed to continue the work.

Return structured markdown with these sections:

## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Preserve exact file paths, function names, command names, test names, error text, and user constraints. Be concise but do not omit information needed to continue.`;

const BRANCH_SUMMARY_SYSTEM_PROMPT = `You are a branch-summary assistant for a coding workflow. Summarize the abandoned branch so the user can revisit or understand it later.

Return structured markdown with these sections:

## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Preserve exact file paths, function names, command names, test names, error text, and user constraints. Be concise but complete.`;

const TITLE_SYSTEM_PROMPT = `You generate short session titles for a coding session.

Rules:
- Return plain text only.
- 2 to 6 words.
- No quotes.
- Prefer concrete technical wording over vague wording.
- No trailing punctuation unless required.`;

class QueueTimeoutError extends Error {
  constructor(public readonly slot: SlotName, public readonly seconds: number) {
    super(`Timed out waiting ${seconds}s for ${slot} to leave the queue`);
    this.name = "QueueTimeoutError";
  }
}

class TaskTimeoutError extends Error {
  constructor(
    public readonly slot: SlotName,
    public readonly model: string,
    public readonly seconds: number,
  ) {
    super(`Timed out after ${seconds}s running ${slot} on ${model}`);
    this.name = "TaskTimeoutError";
  }
}

let inFlight = 0;
const waiters: Array<() => void> = [];

function createEmptyUsageTotals(): UsageTotals {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${value}`;
}

function formatCost(value: number): string {
  return value.toFixed(3);
}

function cacheHitRate(totals: UsageTotals): number {
  const denom = totals.input + totals.cacheRead;
  if (denom <= 0) return 0;
  return (totals.cacheRead / denom) * 100;
}

function costForModel(totals: UsageTotals, model: PiModel | undefined): number {
  if (!model) return totals.cost;
  const usage: Usage = {
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    totalTokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return calculateCost(model, usage).total;
}

function formatOffloadFooter(totals: UsageTotals, mainModel?: PiModel): string {
  return `↑${formatTokenCount(totals.input)} ↓${formatTokenCount(totals.output)} R${formatTokenCount(totals.cacheRead)} CH${cacheHitRate(totals).toFixed(1)}% $${formatCost(costForModel(totals, mainModel))} (offload)`;
}

function formatOffloadWidget(totals: UsageTotals, mainModel?: PiModel): string {
  return `Offload accounting: ${totals.calls} call${totals.calls === 1 ? "" : "s"} · ↑${formatTokenCount(totals.input)} ↓${formatTokenCount(totals.output)} R${formatTokenCount(totals.cacheRead)} · CH${cacheHitRate(totals).toFixed(1)}% · $${formatCost(costForModel(totals, mainModel))}`;
}

function truncatePlainText(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}

function offloadWidget(value: string): WidgetFactory {
  return (_tui, theme) => ({
    render(width: number): string[] {
      return [theme.fg("dim", truncatePlainText(value, width))];
    },
    invalidate() {},
  });
}

function addUsage(totals: UsageTotals, usage: Usage): void {
  totals.calls += 1;
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

function resetUsageTotals(totals: UsageTotals): void {
  totals.calls = 0;
  totals.input = 0;
  totals.output = 0;
  totals.cacheRead = 0;
  totals.cacheWrite = 0;
  totals.cost = 0;
}

function isPersistedOffloadUsageEntry(entry: SessionEntry): entry is SessionEntry & { type: "custom"; customType: string; data?: PersistedOffloadUsage } {
  return entry.type === "custom" && entry.customType === OFFLOAD_USAGE_ENTRY_TYPE;
}

function restorePersistedOffloadUsage(
  entries: SessionEntry[],
  totals: UsageTotals,
  bySlot: Record<SlotName, UsageTotals>,
): void {
  resetUsageTotals(totals);
  for (const slot of SLOT_NAMES) resetUsageTotals(bySlot[slot]);

  for (const entry of entries) {
    if (!isPersistedOffloadUsageEntry(entry)) continue;
    const data = entry.data;
    if (!data || !SLOT_SET.has(data.slot)) continue;
    addUsage(totals, data.usage);
    addUsage(bySlot[data.slot], data.usage);
  }
}

function parseConfigText(text: string): unknown {
  return parseJsonc(text);
}

function loadPackageDefaultConfig(): OffloadRouterConfig {
  return parseConfigText(readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as OffloadRouterConfig;
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureRuntimeConfigFile(): unknown {
  if (!existsSync(CONFIG_PATH)) {
    const config = loadPackageDefaultConfig();
    writeJsonFile(CONFIG_PATH, config);
    return config;
  }
  return parseConfigText(readFileSync(CONFIG_PATH, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeConfig(raw: unknown): OffloadRouterConfig {
  const defaults = loadPackageDefaultConfig();
  const value = isRecord(raw) ? raw : {};
  const rawDefaults = isRecord(value.defaults) ? value.defaults : {};
  const rawOffloads = isRecord(value.offloads) ? value.offloads : {};
  const normalizedOffloads: Record<string, OffloadTaskConfig> = {};

  for (const slot of SLOT_NAMES) {
    const rawOffload = isRecord(rawOffloads[slot]) ? (rawOffloads[slot] as OffloadTaskConfig) : {};
    normalizedOffloads[slot] = { ...defaults.offloads[slot], ...rawOffload };
  }

  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    defaults: {
      model: typeof rawDefaults.model === "string" ? rawDefaults.model : defaults.defaults.model,
      taskTimeoutSeconds:
        typeof rawDefaults.taskTimeoutSeconds === "number"
          ? rawDefaults.taskTimeoutSeconds
          : defaults.defaults.taskTimeoutSeconds,
      queueTimeoutSeconds:
        typeof rawDefaults.queueTimeoutSeconds === "number"
          ? rawDefaults.queueTimeoutSeconds
          : defaults.defaults.queueTimeoutSeconds,
      maxTokens: typeof rawDefaults.maxTokens === "number" ? rawDefaults.maxTokens : defaults.defaults.maxTokens,
    },
    offloads: normalizedOffloads,
    concurrency: {
      maxInFlight: Math.max(
        1,
        isRecord(value.concurrency) && typeof value.concurrency.maxInFlight === "number"
          ? value.concurrency.maxInFlight
          : defaults.concurrency.maxInFlight,
      ),
    },
  };
}

function getConfig(): OffloadRouterConfig {
  const raw = ensureRuntimeConfigFile();
  return normalizeConfig(raw);
}

function saveConfig(config: OffloadRouterConfig): void {
  writeJsonFile(CONFIG_PATH, config);
}

function emit(ctx: { hasUI: boolean; ui: { notify: (message: string, level?: NotifyLevel) => void } }, message: string, level: NotifyLevel = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(message.endsWith("\n") ? message : `${message}\n`);
}

function splitModelString(model: string): { provider: string; modelId: string } | undefined {
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex === model.length - 1) return undefined;
  return { provider: model.slice(0, slashIndex), modelId: model.slice(slashIndex + 1) };
}

function isValidModelSpecifier(value: string): boolean {
  return value === "main" || !!splitModelString(value);
}

function getOffloadTask(config: OffloadRouterConfig, slot: SlotName): ResolvedOffloadTask {
  const offload = config.offloads[slot] ?? {};
  return {
    model: offload.model ?? "default",
    taskTimeoutSeconds: offload.taskTimeoutSeconds ?? config.defaults.taskTimeoutSeconds,
    queueTimeoutSeconds: offload.queueTimeoutSeconds ?? config.defaults.queueTimeoutSeconds,
    maxTokens: offload.maxTokens ?? config.defaults.maxTokens,
  };
}

function resolveModelSpecifier(config: OffloadRouterConfig, slot: SlotName): ModelSpecifier {
  const model = getOffloadTask(config, slot).model;
  return model === "default" ? config.defaults.model : model;
}

function resolveModelForSpecifier(specifier: ModelSpecifier, ctx: ExtensionCtx): PiModel | undefined {
  if (specifier === "main") return ctx.model;
  const parsed = splitModelString(specifier);
  return parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
}

function resolveModelForSlot(config: OffloadRouterConfig, slot: SlotName, ctx: ExtensionCtx): PiModel | undefined {
  return resolveModelForSpecifier(resolveModelSpecifier(config, slot), ctx);
}

function modelLabel(model: PiModel | undefined): string {
  return model ? `${model.provider}/${model.id}` : "(unresolved)";
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause ? ` ${errorText(error.cause)}` : "";
    return `${error.name} ${error.message}${cause}`;
  }
  return String(error);
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof TaskTimeoutError) return true;
  const text = errorText(error).toLowerCase();
  return text.includes("timeout") || text.includes("timed out");
}

function notifyQueueTimeout(ctx: ExtensionCtx, error: QueueTimeoutError): void {
  emit(
    ctx,
    `Offload queue timed out: ${error.slot} waited ${error.seconds}s. Continuing without offload result; main model is ${modelLabel(ctx.model)}.`,
    "warning",
  );
}

function notifyTaskTimeout(ctx: ExtensionCtx, error: TaskTimeoutError): void {
  emit(
    ctx,
    `Offload timed out: ${error.slot} on ${error.model} after ${error.seconds}s. Continuing without offload result; main model is ${modelLabel(ctx.model)}.`,
    "warning",
  );
}

function availableModelIds(ctx: ExtensionCtx): string[] {
  return ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
}

function themedStatus(ctx: ExtensionCtx, text: string): string {
  return ctx.ui.theme?.fg("dim", text) ?? text;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function filterCompletionValues(values: string[], prefix: string): Array<{ value: string; label: string }> | null {
  const filtered = uniqueStrings(values).filter((value) => value.startsWith(prefix));
  return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
}

function offloadModelSuggestions(config: OffloadRouterConfig, availableModels: string[]): string[] {
  return uniqueStrings([config.defaults.model, "main", ...availableModels]);
}

function slotModelSuggestions(config: OffloadRouterConfig, availableModels: string[]): string[] {
  return uniqueStrings(["default", ...offloadModelSuggestions(config, availableModels)]);
}

function getOffloadArgumentCompletions(
  prefix: string,
  config: OffloadRouterConfig,
  availableModels: string[],
): Array<{ value: string; label: string }> | null {
  const hasTrailingSpace = /\s$/.test(prefix);
  const parts = prefix.trim().split(/\s+/).filter(Boolean);
  const subcommands = ["status", "on", "off", "model", "slot", "test"];

  if (!parts.length) return filterCompletionValues(subcommands, "");

  const [subcommand, second = "", third = ""] = parts;
  if (parts.length === 1 && !hasTrailingSpace) return filterCompletionValues(subcommands, subcommand);

  if (subcommand === "model") {
    if (parts.length === 1 && hasTrailingSpace) return filterCompletionValues(offloadModelSuggestions(config, availableModels), "");
    if (parts.length === 2 && !hasTrailingSpace) return filterCompletionValues(offloadModelSuggestions(config, availableModels), second);
    return null;
  }

  if (subcommand === "slot") {
    if (parts.length === 1 && hasTrailingSpace) return filterCompletionValues(SLOT_NAMES, "");
    if (parts.length === 2 && !hasTrailingSpace) return filterCompletionValues(SLOT_NAMES, second);
    if (parts.length === 2 && hasTrailingSpace) return filterCompletionValues(slotModelSuggestions(config, availableModels), "");
    if (parts.length === 3 && !hasTrailingSpace) return filterCompletionValues(slotModelSuggestions(config, availableModels), third);
    return null;
  }

  if (subcommand === "test") {
    if (parts.length === 1 && hasTrailingSpace) return filterCompletionValues(SLOT_NAMES, "");
    if (parts.length === 2 && !hasTrailingSpace) return filterCompletionValues(SLOT_NAMES, second);
    return null;
  }

  return null;
}

function statusText(
  config: OffloadRouterConfig,
  ctx: ExtensionCtx,
  totals: UsageTotals,
  bySlot: Record<SlotName, UsageTotals>,
): string {
  const lines = [
    `enabled: ${config.enabled}`,
    `config: ${CONFIG_PATH}`,
    `defaults.model: ${config.defaults.model}`,
    `defaults.taskTimeoutSeconds: ${config.defaults.taskTimeoutSeconds}`,
    `defaults.queueTimeoutSeconds: ${config.defaults.queueTimeoutSeconds}`,
    `defaults.maxTokens: ${config.defaults.maxTokens}`,
    `concurrency.maxInFlight: ${config.concurrency.maxInFlight}`,
    `inFlight: ${inFlight}`,
    `offload totals: ${formatOffloadFooter(totals, ctx.model)}`,
  ];

  for (const slot of SLOT_NAMES) {
    const offload = getOffloadTask(config, slot);
    const configuredModel = config.offloads[slot]?.model ?? "default";
    const resolvedSpecifier = resolveModelSpecifier(config, slot);
    const model = resolveModelForSpecifier(resolvedSpecifier, ctx);
    const usage = bySlot[slot];
    lines.push(
      `${slot}: model=${configuredModel} -> ${resolvedSpecifier} -> ${modelLabel(model)}; queue=${offload.queueTimeoutSeconds}s; task=${offload.taskTimeoutSeconds}s; maxTokens=${offload.maxTokens}; usage=${formatOffloadFooter(usage, ctx.model)} calls=${usage.calls}`,
    );
  }

  const available = availableModelIds(ctx);
  if (available.length) lines.push(`available: ${available.join(", ")}`);
  return lines.join("\n");
}

async function acquireSlot(slot: SlotName, limit: number, queueTimeoutSeconds: number): Promise<() => void> {
  const normalizedLimit = Math.max(1, limit);
  if (inFlight < normalizedLimit) {
    inFlight += 1;
    return () => {
      inFlight -= 1;
      waiters.shift()?.();
    };
  }

  await new Promise<void>((resolve, reject) => {
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(wake);
      if (index >= 0) waiters.splice(index, 1);
      reject(new QueueTimeoutError(slot, queueTimeoutSeconds));
    }, Math.max(0, queueTimeoutSeconds) * 1000);
    waiters.push(wake);
  });

  inFlight += 1;
  return () => {
    inFlight -= 1;
    waiters.shift()?.();
  };
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function assistantResponseSummary(message: AssistantMessage, model: PiModel | undefined): string {
  const contentTypes = message.content.map((item) => item.type).join(", ") || "none";
  const usage = message.usage
    ? ` usage=input:${message.usage.input} output:${message.usage.output} cacheRead:${message.usage.cacheRead} cacheWrite:${message.usage.cacheWrite} total:${message.usage.totalTokens}`
    : "";
  const error = message.errorMessage ? ` error=${message.errorMessage}` : "";
  return `model=${modelLabel(model)} stopReason=${message.stopReason ?? "unknown"} contentTypes=${contentTypes}${usage}${error}`;
}

async function completeForSlot(
  config: OffloadRouterConfig,
  slot: SlotName,
  ctx: ExtensionCtx,
  systemPrompt: string,
  prompt: string,
  options: {
    signal?: AbortSignal;
    maxTokens?: number;
    statusKey?: string;
    statusText?: string;
    onUsage?: (usage: Usage) => void;
    sessionId?: string;
  } = {},
): Promise<AssistantMessage | undefined> {
  const model = resolveModelForSlot(config, slot, ctx);
  if (!model) return undefined;

  const offload = getOffloadTask(config, slot);
  let release: () => void;
  try {
    release = await acquireSlot(slot, config.concurrency.maxInFlight, offload.queueTimeoutSeconds);
  } catch (error) {
    if (error instanceof QueueTimeoutError) notifyQueueTimeout(ctx, error);
    throw error;
  }

  const statusKey = options.statusKey ?? `offload-${slot}`;
  const statusText = options.statusText ?? `Running ${slot}...`;
  const taskTimeout = new TaskTimeoutError(slot, modelLabel(model), offload.taskTimeoutSeconds);
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(taskTimeout), Math.max(0, offload.taskTimeoutSeconds) * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutController.signal]) : timeoutController.signal;

  try {
    ctx.ui.setStatus(statusKey, statusText);
    const response = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: options.maxTokens ?? offload.maxTokens,
        timeoutMs: offload.taskTimeoutSeconds * 1000,
        signal,
        cacheRetention: "short",
        sessionId: options.sessionId ?? `offload-router:${slot}`,
      },
    );
    if (response.usage) options.onUsage?.(response.usage);
    return response;
  } catch (error) {
    if (timeoutController.signal.aborted || isTimeoutError(error)) {
      notifyTaskTimeout(ctx, taskTimeout);
      throw taskTimeout;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    ctx.ui.setStatus(statusKey, undefined);
    release();
  }
}

function entryTimestamp(entry: SessionEntry): number {
  return new Date(entry.timestamp).getTime();
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  switch (entry.type) {
    case "message":
      return entry.message;
    case "compaction":
      return {
        role: "compactionSummary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: entryTimestamp(entry),
      };
    case "branch_summary":
      return {
        role: "branchSummary",
        summary: entry.summary,
        fromId: entry.fromId,
        timestamp: entryTimestamp(entry),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: entryTimestamp(entry),
      };
    default:
      return undefined;
  }
}

function compactedBranchForHandoff(branch: SessionEntry[]): SessionEntry[] {
  let compactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    if (branch[i]?.type === "compaction") {
      compactionIndex = i;
      break;
    }
  }

  if (compactionIndex < 0) return branch;

  const compaction = branch[compactionIndex];
  if (!compaction || compaction.type !== "compaction") return branch;

  const firstKeptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  return [
    compaction,
    ...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
    ...branch.slice(compactionIndex + 1),
  ];
}

function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
  return compactedBranchForHandoff(branch)
    .map(entryToMessage)
    .filter((message): message is AgentMessage => message !== undefined);
}

function ensureFinalNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function findProjectRoot(cwd: string): string {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

async function shouldOverwrite(targetPath: string, ctx: ExtensionCtx): Promise<boolean> {
  if (!existsSync(targetPath)) return true;
  if (!ctx.hasUI) return true;
  return ctx.ui.confirm("Overwrite HANDOFF.md?", `${targetPath} already exists. Overwrite it?\n\nDefault: Yes`);
}

function countConversationMessages(branch: SessionEntry[]): { user: number; assistant: number } {
  let user = 0;
  let assistant = 0;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") user += 1;
    if (entry.message.role === "assistant") assistant += 1;
  }
  return { user, assistant };
}

function clipTitle(value: string): string {
  return value.replace(/^['"`]+|['"`]+$/g, "").replace(/\s+/g, " ").trim().slice(0, 80).trim();
}

function handlePassiveFailure(_ctx: ExtensionCtx, _slot: SlotName, _error: unknown): void {}

export default function offloadRouter(pi: ExtensionAPI) {
  const offloadTotals = createEmptyUsageTotals();
  const offloadSessionId = uuidv7();
  let completionModels: string[] = [];
  const offloadBySlot: Record<SlotName, UsageTotals> = {
    compaction: createEmptyUsageTotals(),
    branchSummary: createEmptyUsageTotals(),
    titleGeneration: createEmptyUsageTotals(),
    handoff: createEmptyUsageTotals(),
  };

  function offloadRequestSessionId(slot: SlotName): string {
    return `offload-router:${offloadSessionId}:${slot}`;
  }

  function refreshOffloadFooter(ctx: ExtensionCtx): void {
    ctx.ui.setStatus("offload-usage", undefined);
    if (offloadTotals.calls > 0) {
      ctx.ui.setWidget("offload-router-accounting", offloadWidget(formatOffloadWidget(offloadTotals, ctx.model)), {
        placement: "belowEditor",
      });
    } else {
      ctx.ui.setWidget("offload-router-accounting", undefined);
    }
  }

  function recordUsage(slot: SlotName, usage: Usage, ctx: ExtensionCtx): void {
    addUsage(offloadTotals, usage);
    addUsage(offloadBySlot[slot], usage);
    pi.appendEntry<PersistedOffloadUsage>(OFFLOAD_USAGE_ENTRY_TYPE, { slot, usage });
    refreshOffloadFooter(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    const extensionCtx = ctx as unknown as ExtensionCtx;
    completionModels = availableModelIds(extensionCtx);
    restorePersistedOffloadUsage(extensionCtx.sessionManager.getEntries(), offloadTotals, offloadBySlot);
    refreshOffloadFooter(extensionCtx);
  });

  pi.registerCommand("offload", {
    description: "Manage offload-router settings: /offload status|on|off|model <model>|slot <slot> <model|default|main>|test [slot] [prompt]",
    getArgumentCompletions: (prefix) => getOffloadArgumentCompletions(prefix, getConfig(), completionModels),
    handler: async (args, ctx) => {
      const config = getConfig();
      completionModels = availableModelIds(ctx as unknown as ExtensionCtx);
      const trimmed = args.trim();
      const [subcommand = "status", ...rest] = trimmed ? trimmed.split(/\s+/) : ["status"];

      if (subcommand === "status") {
        emit(ctx, statusText(config, ctx as unknown as ExtensionCtx, offloadTotals, offloadBySlot), "info");
        return;
      }

      if (subcommand === "on" || subcommand === "off") {
        config.enabled = subcommand === "on";
        saveConfig(config);
        emit(ctx, `offload-router ${config.enabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      if (subcommand === "model") {
        const model = rest.join(" ").trim();
        if (!model) {
          emit(ctx, "Usage: /offload model <model>", "warning");
          return;
        }
        if (!isValidModelSpecifier(model)) {
          emit(ctx, "Model must be main or provider/modelId", "warning");
          return;
        }
        config.defaults.model = model;
        saveConfig(config);
        emit(ctx, `default model set to ${model}`, "info");
        return;
      }

      if (subcommand === "slot") {
        const [slot, value, ...extra] = rest;
        if (!slot || !value || extra.length) {
          emit(ctx, "Usage: /offload slot <slot> <model|default|main>", "warning");
          return;
        }
        if (!SLOT_SET.has(slot as SlotName)) {
          emit(ctx, `Unknown slot: ${slot}`, "warning");
          return;
        }
        if (value !== "default" && value !== "main" && !splitModelString(value)) {
          emit(ctx, "Slot value must be default, main, or provider/modelId", "warning");
          return;
        }
        config.offloads[slot] = { ...(config.offloads[slot] ?? {}), model: value };
        saveConfig(config);
        emit(ctx, `${slot} model set to ${value}`, "info");
        return;
      }

      if (subcommand === "test") {
        const [maybeSlot, ...restPrompt] = rest;
        const slot = SLOT_SET.has(maybeSlot as SlotName) ? (maybeSlot as SlotName) : undefined;
        const effectiveSlot = slot ?? "handoff";
        const prompt = slot ? restPrompt.join(" ").trim() : rest.join(" ").trim();

        try {
          const response = await completeForSlot(
            config,
            effectiveSlot,
            ctx as unknown as ExtensionCtx,
            "Reply briefly to confirm the offload slot works.",
            prompt || "Reply with OK and the model you are running on.",
            {
              maxTokens: 120,
              statusKey: "offload-test",
              statusText: `Testing ${effectiveSlot}...`,
              onUsage: (usage) => recordUsage(effectiveSlot, usage, ctx as unknown as ExtensionCtx),
              sessionId: offloadRequestSessionId(effectiveSlot),
            },
          );
          if (!response) {
            emit(ctx, `Could not resolve a model for ${effectiveSlot}`, "warning");
            return;
          }
          const model = resolveModelForSlot(config, effectiveSlot, ctx as unknown as ExtensionCtx);
          emit(ctx, `test ${effectiveSlot} -> ${modelLabel(model)}\n${extractText(response)}`, "info");
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emit(ctx, `Test failed: ${message}`, "error");
          return;
        }
      }

      emit(ctx, "Usage: /offload status|on|off|model <model>|slot <slot> <model|default|main>|test [slot] [prompt]", "warning");
    },
  });

  pi.registerCommand("handoff", {
    description: "Write a context handoff summary to HANDOFF.md in the current project root",
    handler: async (args, ctx) => {
      const config = getConfig();
      const focus = args.trim() || "General continuation handoff for this session.";
      const projectRoot = findProjectRoot(ctx.cwd);
      const targetPath = join(projectRoot, HANDOFF_FILE);

      if (!(await shouldOverwrite(targetPath, ctx as unknown as ExtensionCtx))) {
        emit(ctx, "Handoff cancelled", "info");
        return;
      }

      try {
        await ctx.waitForIdle?.();
        const messages = getHandoffMessages(ctx.sessionManager.getBranch());
        if (!messages.length) {
          emit(ctx, "No conversation to hand off", "error");
          return;
        }

        const conversationText = serializeConversation(convertToLlm(messages));
        const prompt = `<conversation>\n${conversationText}\n</conversation>\n\n<handoff-focus>\n${focus}\n</handoff-focus>\n\nCreate HANDOFF.md for the current project at ${projectRoot}.`;
        const response = await completeForSlot(
          config,
          "handoff",
          ctx as unknown as ExtensionCtx,
          HANDOFF_SYSTEM_PROMPT,
          prompt,
          {
            statusKey: "handoff",
            statusText: "Generating handoff...",
            onUsage: (usage) => recordUsage("handoff", usage, ctx as unknown as ExtensionCtx),
            sessionId: offloadRequestSessionId("handoff"),
          },
        );

        if (!response) {
          emit(ctx, "Could not resolve a model for handoff", "error");
          return;
        }

        const handoff = extractText(response);
        if (!handoff.trim()) {
          const model = resolveModelForSlot(config, "handoff", ctx as unknown as ExtensionCtx);
          emit(ctx, `Handoff generation returned empty content (${assistantResponseSummary(response, model)})`, "error");
          return;
        }

        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, ensureFinalNewline(handoff), "utf8");
        emit(ctx, `Wrote ${targetPath}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit(ctx, `Failed to write ${targetPath}: ${message}`, "error");
      }
    },
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const config = getConfig();
    if (!config.enabled) return;

    const { preparation, signal } = event;
    const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;
    const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
    if (!allMessages.length) return;

    const conversationText = serializeConversation(convertToLlm(allMessages));
    const previousContext = previousSummary ? `\n\nPrevious summary for context:\n${previousSummary}` : "";
    const prompt = `${previousContext}\n\nSummarize the following conversation for compaction. Preserve all context needed to continue the work.\n\n<conversation>\n${conversationText}\n</conversation>`;

    try {
      const response = await completeForSlot(
        config,
        "compaction",
        ctx as unknown as ExtensionCtx,
        COMPACTION_SYSTEM_PROMPT,
        prompt,
        {
          signal,
          statusKey: "offload-compaction",
          statusText: "Offload compaction...",
          onUsage: (usage) => recordUsage("compaction", usage, ctx as unknown as ExtensionCtx),
          sessionId: offloadRequestSessionId("compaction"),
        },
      );
      const summary = response ? extractText(response) : "";
      if (!summary.trim()) return;
      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
        },
      };
    } catch (error) {
      handlePassiveFailure(ctx as unknown as ExtensionCtx, "compaction", error);
      return;
    }
  });

  pi.on("session_before_tree", async (event, ctx) => {
    const config = getConfig();
    if (!config.enabled) return;
    if (!event.preparation.userWantsSummary) return;

    const messages = event.preparation.entriesToSummarize
      .map(entryToMessage)
      .filter((message): message is AgentMessage => message !== undefined);
    if (!messages.length) return;

    const conversationText = serializeConversation(convertToLlm(messages));
    const prompt = `Summarize this branch that the user is leaving behind. Preserve anything needed to understand or resume it later.\n\n<branch>\n${conversationText}\n</branch>`;

    try {
      const response = await completeForSlot(
        config,
        "branchSummary",
        ctx as unknown as ExtensionCtx,
        BRANCH_SUMMARY_SYSTEM_PROMPT,
        prompt,
        {
          signal: event.signal,
          statusKey: "offload-branch-summary",
          statusText: "Offload branch summary...",
          onUsage: (usage) => recordUsage("branchSummary", usage, ctx as unknown as ExtensionCtx),
          sessionId: offloadRequestSessionId("branchSummary"),
        },
      );
      const summary = response ? extractText(response) : "";
      if (!summary.trim()) return;
      return { summary: { summary } };
    } catch (error) {
      handlePassiveFailure(ctx as unknown as ExtensionCtx, "branchSummary", error);
      return;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const config = getConfig();
    if (!config.enabled) return;
    if (pi.getSessionName()) return;

    const counts = countConversationMessages(ctx.sessionManager.getBranch());
    if (counts.user < 1 || counts.assistant < 1) return;

    const messages = getHandoffMessages(ctx.sessionManager.getBranch());
    if (!messages.length) return;

    const conversationText = serializeConversation(convertToLlm(messages.slice(-8)));
    const prompt = `Generate a concise session title for this coding conversation.\n\n<conversation>\n${conversationText}\n</conversation>`;

    try {
      const response = await completeForSlot(
        config,
        "titleGeneration",
        ctx as unknown as ExtensionCtx,
        TITLE_SYSTEM_PROMPT,
        prompt,
        {
          statusKey: "offload-title",
          statusText: "Generating title...",
          onUsage: (usage) => recordUsage("titleGeneration", usage, ctx as unknown as ExtensionCtx),
          sessionId: offloadRequestSessionId("titleGeneration"),
        },
      );
      const title = clipTitle(response ? extractText(response) : "");
      if (!title) return;
      if (!pi.getSessionName()) pi.setSessionName(title);
    } catch (error) {
      handlePassiveFailure(ctx as unknown as ExtensionCtx, "titleGeneration", error);
      return;
    }
  });
}
