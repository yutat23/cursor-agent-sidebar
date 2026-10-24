import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as readline from "node:readline";
import { EventEmitter } from "node:events";
import {
  AcpSessionInfo,
  normalizeModelId,
  parseConfigOptions,
  parseModelIdParameters,
  parseSessionConfig,
  SessionPickerConfig,
} from "./sessionConfig";

export type AgentMode = "agent" | "plan" | "ask";

export interface PlanTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export interface AcpClientOptions {
  agentPath: string;
  cwd: string;
  autoApprovePermissions: boolean;
  // Sent to the agent as this client's version.
  clientVersion: string;
}

export interface SessionUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
  };
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
}

type InteractionRelease = () => void;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds a readable message from a JSON-RPC error. The Cursor CLI reports the
 * actual reason in `error.data.message` (e.g. "Invalid model value: x") while
 * `error.message` is only the generic "Invalid params", so include both.
 */
export function formatRpcError(error: { message?: string; code?: number; data?: unknown }): string {
  const base = error.message ?? "ACP error";
  const data = error.data;
  if (data === undefined || data === null) {
    return base;
  }

  let detail: string;
  if (typeof data === "string") {
    detail = data;
  } else if (typeof data === "object" && typeof (data as { message?: unknown }).message === "string") {
    detail = (data as { message: string }).message;
  } else {
    try {
      detail = JSON.stringify(data);
    } catch {
      detail = String(data);
    }
  }

  if (!detail || detail === base) {
    return base;
  }
  return `${base}: ${detail}`;
}

function isOnPath(command: string): boolean {
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(nodePath.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of extensions) {
      try {
        fs.accessSync(nodePath.join(dir, command + ext), fs.constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

/**
 * Picks the command that starts the Cursor CLI. Grok Build also installs a
 * command named "agent", usually ahead of Cursor's on PATH, so unless the user
 * chose one, prefer "cursor-agent", which only the Cursor CLI installs.
 */
export function resolveAgentPath(configured: string | undefined): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    return trimmed;
  }
  return isOnPath("cursor-agent") ? "cursor-agent" : "agent";
}

export function validateAgentPath(agentPath: string): string {
  const normalized = agentPath.trim();
  if (!normalized) {
    throw new Error("The Cursor CLI agent path is empty");
  }

  if (process.platform === "win32" && /[&|<>^\"`%!]/.test(normalized)) {
    throw new Error("agentPath cannot contain shell metacharacters");
  }

  return normalized;
}

function parsePlanTodos(raw: unknown): PlanTodo[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const todos: PlanTodo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.content !== "string" || !rec.content.trim()) {
      continue;
    }
    const status = rec.status;
    todos.push({
      id: typeof rec.id === "string" && rec.id ? rec.id : String(todos.length + 1),
      content: rec.content,
      status:
        status === "in_progress" || status === "completed" || status === "cancelled"
          ? status
          : "pending",
    });
  }
  return todos;
}

const CANCEL_TIMEOUT_MS = 5_000;

export type SessionConfigWithId = SessionPickerConfig & { sessionId: string };

function paramSessionId(params?: Record<string, unknown>): string | undefined {
  return typeof params?.sessionId === "string" ? params.sessionId : undefined;
}

/**
 * Speaks ACP to one `agent acp` process. It keeps no notion of a "current"
 * session: every call names its session and every event carries the session
 * it belongs to, so the caller decides what to show.
 */
export class AcpClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | undefined;
  private rl: readline.Interface | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private disposed = false;
  // Prompts in flight, by session.
  private runningPrompts = new Map<string, number>();
  private promptRun = 0;
  // Interactions waiting for the user, by session ("" when the agent did not say).
  private interactionReleases = new Map<string, Set<InteractionRelease>>();
  private supportsSessionList = false;
  private supportsLoadSession = false;

  private autoApprovePermissions: boolean;

  constructor(private readonly options: AcpClientOptions) {
    super();
    this.autoApprovePermissions = options.autoApprovePermissions;
  }

  setAutoApprovePermissions(enabled: boolean): void {
    this.autoApprovePermissions = enabled;
  }

  getAutoApprovePermissions(): boolean {
    return this.autoApprovePermissions;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    this.process = spawn(validateAgentPath(this.options.agentPath), ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      cwd: this.options.cwd,
      env: { ...process.env },
    });

    this.rl = readline.createInterface({ input: this.process.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    this.process.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        this.emit("log", text);
      }
    });

    // Writing to the agent after it exits fails with EPIPE; without a listener
    // that error would be thrown as an uncaught exception.
    this.process.stdin.on("error", (err) => {
      this.emit("log", `Failed to write to the agent process: ${err.message}`);
    });

    this.process.on("exit", (code) => {
      this.process = undefined;
      this.emit("exit", code);
      this.cleanup();
    });

    this.process.on("error", (err) => {
      this.emit("log", `Failed to start the agent process: ${err.message}`);
      this.cleanup(err);
    });

    const initResult = (await this.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: {
          parameterizedModelPicker: true,
        },
      },
      clientInfo: { name: "cursor-agent-sidebar", version: this.options.clientVersion },
    })) as {
      agentCapabilities?: {
        loadSession?: boolean;
        sessionCapabilities?: { list?: Record<string, unknown> };
      };
    };

    this.supportsLoadSession = initResult.agentCapabilities?.loadSession === true;
    this.supportsSessionList = initResult.agentCapabilities?.sessionCapabilities?.list !== undefined;

    await this.send("authenticate", { methodId: "cursor_login" });
  }

  get canListSessions(): boolean {
    return this.supportsSessionList;
  }

  get canLoadSession(): boolean {
    return this.supportsLoadSession;
  }

  async listSessions(cursor?: string): Promise<{ sessions: AcpSessionInfo[]; nextCursor?: string }> {
    if (!this.supportsSessionList) {
      return { sessions: [] };
    }

    const result = (await this.send("session/list", {
      cwd: this.options.cwd,
      ...(cursor ? { cursor } : {}),
    })) as { sessions?: AcpSessionInfo[]; nextCursor?: string };

    return {
      sessions: result.sessions ?? [],
      nextCursor: result.nextCursor,
    };
  }

  /** Loads a saved session; its history arrives as updates for it before this resolves. */
  async loadSession(sessionId: string): Promise<SessionConfigWithId> {
    if (!this.supportsLoadSession) {
      throw new Error("This agent does not support loading session history");
    }

    const result = (await this.send("session/load", {
      sessionId,
      cwd: this.options.cwd,
      mcpServers: [],
    })) as Parameters<typeof parseSessionConfig>[0];

    return { ...parseSessionConfig({ ...result, sessionId }), sessionId };
  }

  async newSession(mode: AgentMode = "agent", modelId?: string): Promise<SessionConfigWithId> {
    const preferredModelId = modelId ? normalizeModelId(modelId) : undefined;
    const preferredParams = modelId ? parseModelIdParameters(modelId) : [];

    const result = (await this.send("session/new", {
      cwd: this.options.cwd,
      mcpServers: [],
      mode,
      ...(preferredModelId ? { model: preferredModelId } : {}),
    })) as Parameters<typeof parseSessionConfig>[0];

    const sessionId = result.sessionId;
    let config = parseSessionConfig(result);

    // A previously saved model may no longer be offered by the CLI (models get
    // renamed or retired between releases). Restoring it must never break the
    // connection, so only try when the CLI still lists it and fall back to the
    // session's current model if the CLI rejects it anyway.
    if (preferredModelId && config.currentModelId !== preferredModelId) {
      const available = config.models.some((m) => m.id === preferredModelId);
      if (!available) {
        this.emit(
          "log",
          `Saved model "${preferredModelId}" is not offered by the agent; using "${config.currentModelId}" instead`
        );
      } else {
        try {
          config = await this.setModel(sessionId, preferredModelId);
        } catch (err) {
          this.emit("log", `Could not restore model "${preferredModelId}": ${errorMessage(err)}`);
        }
      }
    }

    if (config.currentModelId !== preferredModelId) {
      return { ...config, sessionId };
    }

    for (const param of preferredParams) {
      const current = config.modelParameters.find((p) => p.id === param.id);
      if (!current || current.currentValue === param.value) {
        continue;
      }
      if (!current.options.some((o) => o.value === param.value)) {
        continue;
      }
      try {
        config = await this.setModelParameter(sessionId, param.id, param.value);
      } catch (err) {
        this.emit("log", `Could not restore model parameter "${param.id}=${param.value}": ${errorMessage(err)}`);
      }
    }

    return { ...config, sessionId };
  }

  async setMode(sessionId: string, modeId: AgentMode): Promise<SessionPickerConfig> {
    await this.send("session/set_mode", { sessionId, modeId });
    const result = (await this.send("session/set_config_option", {
      sessionId,
      configId: "mode",
      value: modeId,
    })) as { configOptions: Parameters<typeof parseConfigOptions>[0] };

    return parseConfigOptions(result.configOptions);
  }

  async setModel(sessionId: string, modelId: string): Promise<SessionPickerConfig> {
    const result = (await this.send("session/set_config_option", {
      sessionId,
      configId: "model",
      value: normalizeModelId(modelId),
    })) as { configOptions: Parameters<typeof parseConfigOptions>[0] };

    return parseConfigOptions(result.configOptions);
  }

  async setModelParameter(sessionId: string, configId: string, value: string): Promise<SessionPickerConfig> {
    const result = (await this.send("session/set_config_option", {
      sessionId,
      configId,
      value,
    })) as { configOptions: Parameters<typeof parseConfigOptions>[0] };

    return parseConfigOptions(result.configOptions);
  }

  async prompt(sessionId: string, blocks: PromptContentBlock[]): Promise<{ stopReason: string }> {
    if (blocks.length === 0) {
      throw new Error("prompt must include at least one content block");
    }

    const run = ++this.promptRun;
    this.runningPrompts.set(sessionId, run);
    try {
      const result = (await this.send("session/prompt", {
        sessionId,
        prompt: blocks,
      })) as { stopReason: string };

      return result;
    } finally {
      if (this.runningPrompts.get(sessionId) === run) {
        this.runningPrompts.delete(sessionId);
      }
    }
  }

  /** Stops the session's prompt; emits "cancelled" with the session id if the prompt does not end by itself. */
  async cancel(sessionId: string): Promise<void> {
    this.releaseBlockedInteractions(sessionId);

    const run = this.runningPrompts.get(sessionId);
    if (run === undefined) {
      this.emit("cancelled", sessionId);
      return;
    }

    // session/cancel is a notification in ACP. Sent as a request, the agent
    // rejects it with "Method not found" and keeps working.
    this.notify("session/cancel", { sessionId });

    // The pending session/prompt resolves with stopReason "cancelled".
    // Fall back in case the agent never answers.
    setTimeout(() => {
      if (this.runningPrompts.get(sessionId) === run) {
        this.runningPrompts.delete(sessionId);
        this.emit("cancelled", sessionId);
      }
    }, CANCEL_TIMEOUT_MS);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cleanup();
    if (this.process) {
      try {
        this.process.stdin.end();
      } catch {
        // ignore
      }
      this.process.kill();
      this.process = undefined;
    }
  }

  private cleanup(cause?: Error): void {
    this.rl?.close();
    this.rl = undefined;
    for (const [, waiter] of this.pending) {
      waiter.reject(cause ?? new Error("ACP process exited"));
    }
    this.pending.clear();
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.process) {
      return Promise.reject(new Error("ACP process not started"));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    this.process.stdin.write(payload);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (!this.process) {
      return;
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.process.stdin.write(payload);
  }

  private respond(id: number, result: unknown): void {
    if (!this.process) {
      return;
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
    this.process.stdin.write(payload);
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit("log", line);
      return;
    }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        if (msg.error) {
          waiter.reject(new Error(formatRpcError(msg.error)));
        } else {
          waiter.resolve(msg.result);
        }
      }
      return;
    }

    if (!msg.method) {
      return;
    }

    switch (msg.method) {
      case "session/update":
        this.emit("update", paramSessionId(msg.params), msg.params?.update as Record<string, unknown>);
        break;
      case "session/request_permission":
        void this.handlePermission(msg.id!, msg.params);
        break;
      case "cursor/ask_question":
        void this.handleAskQuestion(msg.id!, msg.params);
        break;
      case "cursor/create_plan":
        void this.handleCreatePlan(msg.id!, msg.params);
        break;
      case "cursor/update_todos":
        this.emit("todos", msg.params);
        break;
      case "cursor/task":
        this.emit("task", msg.params);
        break;
      default:
        if (msg.id !== undefined) {
          this.respond(msg.id, {});
        }
        break;
    }
  }

  private trackInteraction<T>(
    sessionId: string | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    const key = sessionId ?? "";
    let releases = this.interactionReleases.get(key);
    if (!releases) {
      releases = new Set();
      this.interactionReleases.set(key, releases);
    }
    const set = releases;

    let release: InteractionRelease = () => undefined;
    const tracked = new Promise<T>((resolve, reject) => {
      release = () => reject(new Error("cancelled"));
      set.add(release);
      void run().then(resolve, reject);
    });

    return tracked.finally(() => {
      set.delete(release);
    });
  }

  private releaseBlockedInteractions(sessionId: string): void {
    for (const key of [sessionId, ""]) {
      const releases = this.interactionReleases.get(key);
      if (!releases) {
        continue;
      }
      for (const release of releases) {
        release();
      }
      this.interactionReleases.delete(key);
    }
  }

  private async handlePermission(id: number, params?: Record<string, unknown>): Promise<void> {
    if (this.autoApprovePermissions) {
      this.respond(id, { outcome: { outcome: "selected", optionId: "allow-once" } });
      return;
    }

    const sessionId = paramSessionId(params);
    const toolCall = params?.toolCall as { title?: string; kind?: string } | undefined;
    const title = toolCall?.title ?? "Tool permission request";
    const kind = toolCall?.kind;

    try {
      const decision = await this.trackInteraction(
        sessionId,
        () =>
          new Promise<string>((resolve) => {
            this.emit("permission", { sessionId, title, kind, resolve });
          })
      );
      this.respond(id, { outcome: { outcome: "selected", optionId: decision } });
    } catch {
      this.respond(id, { outcome: { outcome: "cancelled" } });
    }
  }

  private async handleAskQuestion(id: number, params?: Record<string, unknown>): Promise<void> {
    const sessionId = paramSessionId(params);
    const questions = (params?.questions as Array<{
      id: string;
      prompt: string;
      options: Array<{ id: string; label: string }>;
      allowMultiple?: boolean;
    }>) ?? [];

    const abort = new AbortController();
    try {
      const answers = await this.trackInteraction(
        sessionId,
        () =>
          new Promise<Array<{ questionId: string; selectedOptionIds: string[] }>>((resolve) => {
            this.emit("askQuestion", {
              sessionId,
              title: params?.title as string | undefined,
              questions,
              signal: abort.signal,
              resolve,
            });
          })
      );

      this.respond(id, {
        outcome: {
          outcome: "answered",
          answers,
        },
      });
    } catch {
      abort.abort();
      this.respond(id, { outcome: { outcome: "cancelled" } });
    }
  }

  private async handleCreatePlan(id: number, params?: Record<string, unknown>): Promise<void> {
    const sessionId = paramSessionId(params);
    let outcome: string;
    try {
      outcome = await this.trackInteraction(
        sessionId,
        () =>
          new Promise<string>((resolve) => {
            this.emit("createPlan", {
              sessionId,
              name: params?.name as string | undefined,
              overview: params?.overview as string | undefined,
              plan: params?.plan as string | undefined,
              todos: parsePlanTodos(params?.todos),
              resolve,
            });
          })
      );
    } catch {
      this.respond(id, { outcome: { outcome: "cancelled" } });
      return;
    }

    if (outcome === "accepted") {
      this.respond(id, { outcome: { outcome: "accepted" } });
    } else if (outcome === "rejected") {
      this.respond(id, { outcome: { outcome: "rejected" } });
    } else {
      this.respond(id, { outcome: { outcome: "cancelled" } });
    }
  }
}
