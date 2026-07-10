import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import { EventEmitter } from "node:events";
import {
  AcpSessionInfo,
  parseConfigOptions,
  parseSessionConfig,
  SessionPickerConfig,
} from "./sessionConfig";

export type AgentMode = "agent" | "plan" | "ask";

export type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export interface AcpClientOptions {
  agentPath: string;
  cwd: string;
  autoApprovePermissions: boolean;
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
  error?: { message?: string; code?: number };
}

type InteractionRelease = () => void;

export class AcpClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | undefined;
  private rl: readline.Interface | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private sessionId: string | undefined;
  private disposed = false;
  private running = false;
  private interactionReleases = new Set<InteractionRelease>();
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

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    this.process = spawn(this.options.agentPath, ["acp"], {
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

    this.process.on("exit", (code) => {
      this.emit("exit", code);
      this.cleanup();
    });

    const initResult = (await this.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "cursor-agent-sidebar", version: "0.1.0" },
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

  async loadSession(sessionId: string): Promise<SessionPickerConfig> {
    if (!this.supportsLoadSession) {
      throw new Error("このエージェントはセッション読み込みに対応していません");
    }

    const result = (await this.send("session/load", {
      sessionId,
      cwd: this.options.cwd,
      mcpServers: [],
    })) as Parameters<typeof parseSessionConfig>[0];

    this.sessionId = sessionId;
    return parseSessionConfig({ ...result, sessionId });
  }

  async newSession(mode: AgentMode = "agent", modelId?: string): Promise<SessionPickerConfig> {
    const result = (await this.send("session/new", {
      cwd: this.options.cwd,
      mcpServers: [],
      mode,
      ...(modelId ? { model: modelId } : {}),
    })) as Parameters<typeof parseSessionConfig>[0];

    this.sessionId = result.sessionId;
    let config = parseSessionConfig(result);

    if (modelId && config.currentModelId !== modelId) {
      config = await this.setModel(modelId);
    }

    return config;
  }

  async setMode(modeId: AgentMode): Promise<SessionPickerConfig> {
    if (!this.sessionId) {
      return this.newSession(modeId);
    }

    await this.send("session/set_mode", { sessionId: this.sessionId, modeId });
    const result = (await this.send("session/set_config_option", {
      sessionId: this.sessionId,
      configId: "mode",
      value: modeId,
    })) as { configOptions: Parameters<typeof parseConfigOptions>[0] };

    return parseConfigOptions(result.configOptions);
  }

  async setModel(modelId: string): Promise<SessionPickerConfig> {
    if (!this.sessionId) {
      return this.newSession("agent", modelId);
    }

    const result = (await this.send("session/set_config_option", {
      sessionId: this.sessionId,
      configId: "model",
      value: modelId,
    })) as { configOptions: Parameters<typeof parseConfigOptions>[0] };

    return parseConfigOptions(result.configOptions);
  }

  async prompt(blocks: PromptContentBlock[]): Promise<{ stopReason: string }> {
    if (!this.sessionId) {
      await this.newSession();
    }

    if (blocks.length === 0) {
      throw new Error("prompt must include at least one content block");
    }

    this.running = true;
    try {
      const result = (await this.send("session/prompt", {
        sessionId: this.sessionId,
        prompt: blocks,
      })) as { stopReason: string };

      return result;
    } finally {
      this.running = false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.running && !this.sessionId) {
      return;
    }

    this.releaseBlockedInteractions();

    if (!this.sessionId) {
      this.running = false;
      this.emit("cancelled");
      return;
    }

    try {
      await this.send("session/cancel", { sessionId: this.sessionId });
    } catch {
      // ignore if already finished
    } finally {
      this.running = false;
      this.emit("cancelled");
    }
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

  private cleanup(): void {
    this.rl?.close();
    this.rl = undefined;
    for (const [, waiter] of this.pending) {
      waiter.reject(new Error("ACP process exited"));
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
          waiter.reject(new Error(msg.error.message ?? "ACP error"));
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
        this.emit("update", msg.params?.update as Record<string, unknown>);
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

  private trackInteraction<T>(run: (release: InteractionRelease) => Promise<T>): Promise<T> {
    let release: InteractionRelease = () => undefined;
    const tracked = new Promise<T>((resolve, reject) => {
      release = () => reject(new Error("cancelled"));
      this.interactionReleases.add(release);
      void run(release).then(resolve, reject);
    });

    return tracked.finally(() => {
      this.interactionReleases.delete(release);
    });
  }

  private releaseBlockedInteractions(): void {
    for (const release of this.interactionReleases) {
      release();
    }
    this.interactionReleases.clear();
  }

  private async handlePermission(id: number, params?: Record<string, unknown>): Promise<void> {
    if (this.autoApprovePermissions) {
      this.respond(id, { outcome: { outcome: "selected", optionId: "allow-once" } });
      return;
    }

    const toolCall = params?.toolCall as { title?: string; kind?: string } | undefined;
    const title = toolCall?.title ?? "ツール実行の許可";
    const kind = toolCall?.kind;

    try {
      const decision = await this.trackInteraction(
        (release) =>
          new Promise<string>((resolve) => {
            const wrappedResolve = (value: string) => {
              this.interactionReleases.delete(release);
              resolve(value);
            };
            this.emit("permission", { title, kind, resolve: wrappedResolve });
          })
      );
      this.respond(id, { outcome: { outcome: "selected", optionId: decision } });
    } catch {
      this.respond(id, { outcome: { outcome: "selected", optionId: "reject-once" } });
    }
  }

  private async handleAskQuestion(id: number, params?: Record<string, unknown>): Promise<void> {
    const questions = (params?.questions as Array<{
      id: string;
      prompt: string;
      options: Array<{ id: string; label: string }>;
      allowMultiple?: boolean;
    }>) ?? [];

    try {
      const answers = await this.trackInteraction(
        (release) =>
          new Promise<Array<{ questionId: string; selectedOptionIds: string[] }>>((resolve) => {
            const wrappedResolve = (value: Array<{ questionId: string; selectedOptionIds: string[] }>) => {
              this.interactionReleases.delete(release);
              resolve(value);
            };
            this.emit("askQuestion", { title: params?.title as string | undefined, questions, resolve: wrappedResolve });
          })
      );

      this.respond(id, {
        outcome: {
          outcome: "answered",
          answers,
        },
      });
    } catch {
      this.respond(id, { outcome: { outcome: "cancelled" } });
    }
  }

  private async handleCreatePlan(id: number, params?: Record<string, unknown>): Promise<void> {
    let outcome: string;
    try {
      outcome = await this.trackInteraction(
        (release) =>
          new Promise<string>((resolve) => {
            const wrappedResolve = (value: string) => {
              this.interactionReleases.delete(release);
              resolve(value);
            };
            this.emit("createPlan", {
              name: params?.name as string | undefined,
              overview: params?.overview as string | undefined,
              plan: params?.plan as string | undefined,
              resolve: wrappedResolve,
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
