import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { AcpClient, AgentMode, PlanTodo, resolveAgentPath, validateAgentPath } from "./acpClient";
import { AcpSessionInfo, formatCurrentModelLabel } from "./sessionConfig";
import { ChangeReviewItem, ChatSession, PermissionPresentation, PermissionRequestState, ThreadMessage, Turn } from "./chatSession";
import { searchFileItems, searchSlashItems } from "./contextCatalog";
import { buildPromptBlocks, getPromptContextPreview, PromptImageAttachment } from "./promptBuilder";
import { loadSessionHistory, SessionHistoryMessage } from "./sessionHistory";
import { FileEditCardData, parseToolUpdate } from "./toolCallParser";
import { CursorUsageSnapshot, fetchCursorUsage, UsageError } from "./usageClient";

type WebviewMessage =
  | { type: "send"; text: string; images?: PromptImageAttachment[] }
  | { type: "removeQueuedPrompt"; id: string }
  | { type: "sendQueuedPrompt"; id: string }
  | { type: "requestSuggestions"; kind: "file" | "slash"; query: string }
  | { type: "requestContextPreview"; text: string }
  | { type: "newChat" }
  | { type: "cancel" }
  | { type: "setMode"; modeId: AgentMode }
  | { type: "setModel"; modelId: string }
  | { type: "setModelParameter"; configId: string; value: string }
  | { type: "permissionResponse"; id: string; decision: string }
  | { type: "planResponse"; id: string; outcome: string }
  | { type: "requestPermissionState" }
  | { type: "removePermissionRule"; id: string }
  | { type: "clearPermissionHistory" }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openDiff"; path: string }
  | { type: "revertFile"; path: string }
  | { type: "requestChangeReview" }
  | { type: "clearChangeReview" }
  | { type: "selectSession"; sessionId: string }
  | { type: "setAutoApprove"; enabled: boolean }
  | { type: "refreshSessions" }
  | { type: "retryConnect" }
  | { type: "openSettings" }
  | { type: "openUsageDashboard" }
  | { type: "requestUsage"; force?: boolean }
  | { type: "runDiagnostics" }
  | { type: "ready" };

const USAGE_CACHE_TTL_MS = 60_000;

interface PermissionRule {
  id: string;
  headline: string;
  detail: string;
  kind?: string;
  createdAt: string;
}

interface PermissionHistoryItem {
  id: string;
  headline: string;
  detail: string;
  decision: string;
  autoApproved: boolean;
  createdAt: string;
}

const MODE_ICONS: Record<AgentMode, string> = {
  agent: "∞",
  plan: "☰",
  ask: "?",
};

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface DiagnosticResult {
  label: string;
  ok: boolean;
  output: string;
}

function sanitizeImageAttachments(images: PromptImageAttachment[] | undefined): PromptImageAttachment[] {
  if (!images?.length) {
    return [];
  }

  const sanitized: PromptImageAttachment[] = [];
  for (const image of images.slice(0, MAX_IMAGE_ATTACHMENTS)) {
    const mimeType = image.mimeType === "image/jpg" ? "image/jpeg" : image.mimeType;
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType) || typeof image.data !== "string") {
      continue;
    }

    const data = image.data.replace(/\s/g, "");
    if (!data) {
      continue;
    }

    const bytes = Buffer.byteLength(data, "base64");
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) {
      continue;
    }

    sanitized.push({ mimeType, data });
  }

  return sanitized;
}

function extractUpdateText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.length > 0 ? content : undefined;
  }
  if (!content) {
    return undefined;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const text = extractUpdateText(block);
      if (text) {
        parts.push(text);
      }
    }
    return parts.length > 0 ? parts.join("") : undefined;
  }
  if (typeof content === "object" && "text" in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      return text;
    }
  }
  return undefined;
}

// What a permission request is for. The tool kind decides when the agent sent
// one; guessing from file extensions in the title called "npm test -- a.ts" a
// file change. "Allow always" rules match on the result, so it must be stable.
function permissionCategory(title: string, kind?: string): "change" | "command" | "read" | "other" {
  switch (kind) {
    case "edit":
    case "delete":
    case "move":
    case "write":
      return "change";
    case "execute":
      return "command";
    case "read":
    case "search":
    case "fetch":
      return "read";
  }

  if (/^\s*(write|edit|create|delete|patch)\b/i.test(title)) {
    return "change";
  }
  if (/^\s*(`|(run|exec|execute|shell|command)\b)/i.test(title)) {
    return "command";
  }
  if (/^\s*(read|glob|grep|search|find|list)\b/i.test(title)) {
    return "read";
  }
  return "other";
}

function isUserMessageUpdate(sessionUpdate: string | undefined): boolean {
  return sessionUpdate === "user_message_chunk" || sessionUpdate === "user_message";
}

function isAgentMessageUpdate(sessionUpdate: string | undefined): boolean {
  return sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_message";
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private readonly locale: "ja" | "en" = vscode.env.language.toLowerCase().startsWith("ja") ? "ja" : "en";
  private view?: vscode.WebviewView;
  private client?: AcpClient;
  // Every session this agent process knows about, shown or not.
  private sessions = new Map<string, ChatSession>();
  // The session shown in the view. Cleared the moment the user leaves it, so
  // nothing from the old session lands in the next one while that is set up.
  private activeId?: string;
  private switchSeq = 0;
  private queueSeq = 0;
  private mode: AgentMode = "agent";
  private modelId = "default";
  private permissionCounter = 0;
  private planCounter = 0;
  private workspaceRoot = "";
  private connectPromise?: Promise<void>;
  private connectEpoch = 0;
  private configSubscription?: vscode.Disposable;
  private usageCache?: CursorUsageSnapshot;
  private usageFetchedAt = 0;
  private usageInFlight?: Promise<void>;
  private readonly output: vscode.OutputChannel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionContext: vscode.ExtensionContext
  ) {
    this.mode = extensionContext.globalState.get<AgentMode>("cursorAgent.mode", "agent");
    this.modelId = extensionContext.globalState.get<string>("cursorAgent.modelId", "default");
    this.output = vscode.window.createOutputChannel("Cursor Agent");
    extensionContext.subscriptions.push(this.output);
  }

  private uiText(japanese: string, english: string): string {
    return this.locale === "ja" ? japanese : english;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      switch (msg.type) {
        case "ready": {
          await this.ensureClient().catch(() => undefined);
          const session = this.active;
          if (session) {
            await this.show(session);
          }
          break;
        }
        case "send":
          await this.handleSend(msg.text, msg.images);
          break;
        case "removeQueuedPrompt":
          this.removeQueuedPrompt(msg.id);
          break;
        case "sendQueuedPrompt":
          await this.sendQueuedPrompt(msg.id);
          break;
        case "requestSuggestions":
          await this.handleRequestSuggestions(msg.kind, msg.query);
          break;
        case "requestContextPreview":
          await this.handleRequestContextPreview(msg.text);
          break;
        case "newChat":
          await this.handleNewChat();
          break;
        case "cancel":
          await this.handleCancel();
          break;
        case "setMode":
          await this.handleSetMode(msg.modeId);
          break;
        case "setModel":
          await this.handleSetModel(msg.modelId);
          break;
        case "setModelParameter":
          await this.handleSetModelParameter(msg.configId, msg.value);
          break;
        case "permissionResponse":
          await this.resolvePermission(msg.id, msg.decision);
          break;
        case "planResponse":
          this.resolvePlan(msg.id, msg.outcome);
          break;
        case "requestPermissionState":
          this.postPermissionState();
          break;
        case "removePermissionRule":
          await this.removePermissionRule(msg.id);
          break;
        case "clearPermissionHistory":
          await this.clearPermissionHistory();
          break;
        case "openFile":
          await this.openFile(msg.path, msg.line);
          break;
        case "openDiff":
          await this.openDiff(msg.path);
          break;
        case "revertFile":
          await this.revertFile(msg.path);
          break;
        case "requestChangeReview":
          this.postChangeReview();
          break;
        case "clearChangeReview":
          this.active?.changeReviewItems.clear();
          this.postChangeReview();
          break;
        case "selectSession":
          await this.handleSelectSession(msg.sessionId);
          break;
        case "setAutoApprove":
          await this.handleSetAutoApprove(msg.enabled);
          break;
        case "refreshSessions":
          await this.refreshSessions();
          break;
        case "retryConnect":
          await this.handleRetryConnect();
          break;
        case "openSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", "cursorAgent.agentPath");
          break;
        case "openUsageDashboard":
          await vscode.env.openExternal(vscode.Uri.parse("https://cursor.com/dashboard/spending"));
          break;
        case "requestUsage":
          await this.handleRequestUsage(!!msg.force);
          break;
        case "runDiagnostics":
          await this.handleRunDiagnostics();
          break;
      }
    });

    this.configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("cursorAgent.autoApprovePermissions")) {
        return;
      }
      this.syncAutoApproveSetting();
    });

    webviewView.onDidDispose(() => {
      this.configSubscription?.dispose();
      this.configSubscription = undefined;
      this.client?.dispose();
      this.client = undefined;
      this.forgetSessions();
    });
  }

  private getAgentPath(): string {
    return resolveAgentPath(vscode.workspace.getConfiguration("cursorAgent").get<string>("agentPath", ""));
  }

  // The setting picks the model for every new chat; otherwise a new chat starts
  // with the model last picked in the view.
  private getNewChatModel(): string {
    const configured = vscode.workspace.getConfiguration("cursorAgent").get<string>("model", "").trim();
    return configured || this.modelId;
  }

  private getAutoApprovePermissions(): boolean {
    return vscode.workspace.getConfiguration("cursorAgent").get<boolean>("autoApprovePermissions", false);
  }

  private syncAutoApproveSetting(): void {
    const enabled = this.getAutoApprovePermissions();
    this.client?.setAutoApprovePermissions(enabled);
    this.post({ type: "settings", autoApprovePermissions: enabled });
  }

  private async handleSetAutoApprove(enabled: boolean): Promise<void> {
    const current = this.getAutoApprovePermissions();
    if (enabled && !current) {
      const enableLabel = this.uiText("有効にする", "Enable");
      const choice = await vscode.window.showWarningMessage(
        this.uiText(
          "自動実行を有効にすると、ファイル変更やコマンド実行が確認なしで許可されます。",
          "When auto-run is enabled, file changes and command execution can be approved without confirmation."
        ),
        { modal: true },
        enableLabel
      );
      if (choice !== enableLabel) {
        this.post({ type: "settings", autoApprovePermissions: current });
        return;
      }
    }

    const config = vscode.workspace.getConfiguration("cursorAgent");
    await config.update("autoApprovePermissions", enabled, vscode.ConfigurationTarget.Global);
    this.client?.setAutoApprovePermissions(enabled);
    this.post({ type: "settings", autoApprovePermissions: enabled });
  }

  async focus(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
    } else {
      await vscode.commands.executeCommand("cursorAgent.chat.focus");
    }
  }

  async newChat(): Promise<void> {
    await this.handleNewChat();
    await this.focus();
  }

  async stop(): Promise<void> {
    await this.handleCancel();
    await this.focus();
  }

  get isRunning(): boolean {
    return this.active?.turn !== undefined;
  }

  private get active(): ChatSession | undefined {
    return this.activeId ? this.sessions.get(this.activeId) : undefined;
  }

  private isActive(session: ChatSession): boolean {
    return session.id === this.activeId;
  }

  // Updates and requests that do not name a session belong to the one shown.
  private sessionFor(sessionId: string | undefined): ChatSession | undefined {
    return sessionId ? this.sessions.get(sessionId) : this.active;
  }

  private async createSession(client: AcpClient, epoch: number): Promise<ChatSession | undefined> {
    if (epoch !== this.connectEpoch || this.client !== client || client.isDisposed) {
      return undefined;
    }

    const config = await client.newSession(this.mode, this.getNewChatModel());
    if (epoch !== this.connectEpoch || this.client !== client || client.isDisposed) {
      return undefined;
    }

    const session = new ChatSession(config.sessionId, config);
    this.sessions.set(session.id, session);
    return session;
  }

  /** Shows a session in a view that already displays the right thread (empty, or kept after a reconnect). */
  private async adopt(session: ChatSession): Promise<void> {
    this.activeId = session.id;
    await this.rememberConfig(session);
    this.postChangeReview();
    this.postQueue();
    this.postRunning();
    this.setRunningContext(session.turn !== undefined);
  }

  /** Redraws the view with everything the session has shown so far. */
  private async show(session: ChatSession): Promise<void> {
    this.activeId = session.id;
    this.post({ type: "clear" });
    for (const message of session.messages) {
      this.post(message);
    }
    await this.adopt(session);
  }

  /** Stops showing the current session; it keeps running in the background. */
  private leave(): number {
    this.activeId = undefined;
    this.setRunningContext(false);
    this.post({ type: "clear" });
    this.postChangeReview();
    this.postQueue();
    return ++this.switchSeq;
  }

  private async rememberConfig(session: ChatSession): Promise<void> {
    if (session.config) {
      this.mode = session.config.currentModeId;
      this.modelId = session.config.currentModelId;
      await this.savePreferences();
    }
    this.postConfig();
  }

  private async connectClient(): Promise<void> {
    const epoch = this.connectEpoch;
    this.post({ type: "init", status: "loading", message: this.uiText("エージェントに接続中...", "Connecting to the agent...") });

    const agentPath = this.getAgentPath();
    const autoApprove = this.getAutoApprovePermissions();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    this.workspaceRoot = cwd;

    const client = new AcpClient({ agentPath, cwd, autoApprovePermissions: autoApprove });
    this.client = client;
    this.bindClientEvents(client);

    try {
      await client.start();
      if (epoch !== this.connectEpoch) {
        this.abandonClient(client);
        return;
      }

      const session = await this.createSession(client, epoch);
      if (!session) {
        return;
      }
      if (!this.activeId) {
        await this.adopt(session);
      }

      await this.refreshSessions();
    } catch (err) {
      if (epoch !== this.connectEpoch) {
        this.abandonClient(client);
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      const errorMessage = this.uiText(`接続に失敗しました: ${message}`, `Connection failed: ${message}`);
      this.post({ type: "init", status: "error", message: errorMessage });
      this.post({ type: "error", text: errorMessage });
      this.abandonClient(client);
      throw err;
    }
  }

  // The agent process holds the sessions; without it they are gone.
  private forgetSessions(): void {
    this.sessions.clear();
    this.activeId = undefined;
  }

  private async handleRetryConnect(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.connectEpoch++;
    this.connectPromise = undefined;
    this.client?.dispose();
    this.client = undefined;
    this.forgetSessions();
    await this.ensureClient().catch(() => undefined);
  }

  private async handleNewChat(): Promise<void> {
    this.connectEpoch++;
    const pendingConnect = this.connectPromise;
    this.connectPromise = undefined;

    if (pendingConnect) {
      await pendingConnect.catch(() => undefined);
    }

    const seq = this.leave();
    this.post({ type: "init", status: "loading", message: this.uiText("新しいチャットを準備中...", "Preparing a new chat...") });

    const epoch = this.connectEpoch;

    try {
      if (!this.client || this.client.isDisposed) {
        await this.ensureClient();
        return;
      }

      const session = await this.createSession(this.client, epoch);
      if (!session || seq !== this.switchSeq) {
        return;
      }

      await this.adopt(session);
      await this.refreshSessions();
    } catch (err) {
      if (epoch !== this.connectEpoch) {
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      const errorMessage = this.uiText(`新しいチャットの開始に失敗: ${message}`, `Failed to start a new chat: ${message}`);
      this.post({ type: "init", status: "error", message: errorMessage });
      this.post({ type: "error", text: errorMessage });

      if (this.client) {
        this.abandonClient(this.client);
      }
      this.forgetSessions();

      this.connectPromise = undefined;
      await this.ensureClient();
    }
  }

  private async handleSelectSession(sessionId: string): Promise<void> {
    if (!sessionId || sessionId === this.activeId) {
      return;
    }

    if (!this.client || this.client.isDisposed) {
      try {
        await this.ensureClient();
      } catch {
        return;
      }
    }

    const client = this.client;
    if (!client) {
      return;
    }

    let session = this.sessions.get(sessionId);
    if (!session && !client.canLoadSession) {
      this.post({ type: "error", text: this.uiText("このエージェントは履歴の読み込みに対応していません", "This agent does not support loading session history") });
      return;
    }

    const previous = this.active;
    const seq = this.leave();

    try {
      let emptyHistory = false;
      if (!session || session.loading) {
        this.post({ type: "sessionLoading", title: this.uiText("チャットを読み込み中...", "Loading chat...") });
        session = session ?? this.loadSession(client, sessionId);
        await session.loading;
        emptyHistory = !session.hasHistory;
      }

      if (seq !== this.switchSeq) {
        return;
      }

      await this.show(session);
      this.post({ type: "sessionLoaded", emptyHistory });
      await this.refreshSessions();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", text: this.uiText(`チャットの読み込みに失敗: ${message}`, `Failed to load chat: ${message}`) });
      this.post({ type: "sessionLoaded" });
      if (seq === this.switchSeq && previous && this.sessions.get(previous.id) === previous) {
        await this.show(previous);
      }
    }
  }

  /** Starts replaying a saved session from the agent; its updates are recorded as they arrive. */
  private loadSession(client: AcpClient, sessionId: string): ChatSession {
    const session = new ChatSession(sessionId);
    this.sessions.set(sessionId, session);
    session.loading = (async () => {
      try {
        session.config = await client.loadSession(sessionId);
        if (session.isAssistantOpen) {
          this.postTo(session, { type: "assistantDone", stopReason: "replay" });
        }
        if (!session.hasHistory) {
          this.replayLocalHistory(session, await loadSessionHistory(sessionId));
        }
      } catch (err) {
        if (this.sessions.get(sessionId) === session) {
          this.sessions.delete(sessionId);
        }
        throw err;
      } finally {
        session.loading = undefined;
      }
    })();
    return session;
  }

  private replayLocalHistory(session: ChatSession, messages: SessionHistoryMessage[]): void {
    for (const message of messages) {
      if (message.role === "user") {
        if (session.isAssistantOpen) {
          this.postTo(session, { type: "assistantDone", stopReason: "replay" });
        }
        this.postTo(session, { type: "userMessage", text: message.text });
        continue;
      }

      if (!session.isAssistantOpen) {
        this.postTo(session, { type: "assistantStart" });
      }
      this.postTo(session, { type: "assistantChunk", text: message.text });
    }

    if (session.isAssistantOpen) {
      this.postTo(session, { type: "assistantDone", stopReason: "replay" });
    }
  }

  private async handleSetMode(modeId: AgentMode): Promise<void> {
    const session = this.active;
    if (!session || session.turn || !this.client) {
      return;
    }

    try {
      session.config = await this.client.setMode(session.id, modeId);
      await this.rememberConfig(session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", text: this.uiText(`モード変更に失敗: ${message}`, `Failed to change mode: ${message}`) });
    }
  }

  private async handleSetModel(modelId: string): Promise<void> {
    const session = this.active;
    if (!session || session.turn || !this.client) {
      return;
    }

    try {
      session.config = await this.client.setModel(session.id, modelId);
      await this.rememberConfig(session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", text: this.uiText(`モデル変更に失敗: ${message}`, `Failed to change model: ${message}`) });
    }
  }

  private async handleSetModelParameter(configId: string, value: string): Promise<void> {
    const session = this.active;
    if (!session || session.turn || !this.client) {
      return;
    }

    try {
      session.config = await this.client.setModelParameter(session.id, configId, value);
      await this.rememberConfig(session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({
        type: "error",
        text: this.uiText(`モデル設定の変更に失敗: ${message}`, `Failed to change model setting: ${message}`),
      });
    }
  }

  private async ensureClient(): Promise<void> {
    if (this.client && !this.client.isDisposed) {
      this.postConfig();
      void this.refreshSessions();
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise.catch(() => undefined);
      if (this.client && !this.client.isDisposed) {
        this.postConfig();
        void this.refreshSessions();
        return;
      }
    }

    this.connectPromise = this.connectClient();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private abandonClient(client: AcpClient): void {
    client.dispose();
    if (this.client === client) {
      this.client = undefined;
    }
  }

  private async handleRunDiagnostics(): Promise<void> {
    const agentPath = this.getAgentPath();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    this.post({
      type: "diagnostics",
      running: true,
      results: [{ label: this.uiText("診断", "Diagnostics"), ok: true, output: this.uiText("Cursor CLI を確認中...", "Checking Cursor CLI...") }],
    });

    const results = await Promise.all([
      this.runAgentDiagnostic(agentPath, cwd, ["--version"], "agent --version"),
      this.runAgentDiagnostic(agentPath, cwd, ["status"], "agent status"),
    ]);

    this.post({ type: "diagnostics", running: false, results });
  }

  private runAgentDiagnostic(
    agentPath: string,
    cwd: string,
    args: string[],
    label: string
  ): Promise<DiagnosticResult> {
    return new Promise((resolve) => {
      let safeAgentPath: string;
      try {
        safeAgentPath = validateAgentPath(agentPath);
      } catch (err) {
        resolve({ label, ok: false, output: err instanceof Error ? err.message : String(err) });
        return;
      }

      const child = spawn(safeAgentPath, args, {
        cwd,
        shell: process.platform === "win32",
        env: { ...process.env },
      });

      let settled = false;
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill();
        resolve({ label, ok: false, output: this.uiText("タイムアウトしました", "Timed out") });
      }, 8_000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ label, ok: false, output: err.message });
      });
      child.on("exit", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const output = `${stdout}${stderr}`.trim() || `(exit code ${code ?? "unknown"})`;
        resolve({ label, ok: code === 0, output });
      });
    });
  }

  private async refreshSessions(): Promise<void> {
    if (!this.client?.canListSessions) {
      return;
    }

    try {
      const sessions: AcpSessionInfo[] = [];
      let cursor: string | undefined;

      do {
        const page = await this.client.listSessions(cursor);
        sessions.push(...page.sessions);
        cursor = page.nextCursor;
      } while (cursor);

      sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

      this.post({
        type: "sessions",
        sessions,
        currentSessionId: this.activeId,
      });
    } catch {
      // ignore list failures
    }
  }

  private async savePreferences(): Promise<void> {
    await this.extensionContext.globalState.update("cursorAgent.mode", this.mode);
    await this.extensionContext.globalState.update("cursorAgent.modelId", this.modelId);
  }

  private async handleToolUpdate(session: ChatSession, update: Record<string, unknown>): Promise<void> {
    const parsed = parseToolUpdate(update, session.toolKinds);
    if (!parsed) {
      return;
    }

    // A status-only update for a file change moves its card along instead of
    // adding an activity row.
    const editInProgress = session.fileEdits.get(parsed.toolCallId);
    if (!parsed.fileEdit && editInProgress && parsed.status) {
      parsed.fileEdit = { ...editInProgress, status: parsed.status, previewLines: [] };
    }

    if (parsed.fileEdit) {
      const existing = session.fileEdits.get(parsed.fileEdit.id);
      const merged: FileEditCardData = {
        ...(existing ?? parsed.fileEdit),
        ...parsed.fileEdit,
        path: this.resolvePath(parsed.fileEdit.path),
        previewLines:
          parsed.fileEdit.previewLines.length > 0
            ? parsed.fileEdit.previewLines
            : (existing?.previewLines ?? []),
        addedLines: parsed.fileEdit.addedLines || existing?.addedLines || 0,
        removedLines: parsed.fileEdit.removedLines || existing?.removedLines || 0,
      };

      if (merged.previewLines.length === 0 && ["completed", "done"].includes(merged.status)) {
        const preview = await this.loadFilePreview(merged.path);
        if (preview) {
          merged.previewLines = preview.previewLines;
          merged.addedLines = preview.addedLines;
        }
      }

      session.fileEdits.set(merged.id, merged);
      this.upsertChangeReviewItem(session, merged);
      const { previousText: _previousText, nextText: _nextText, ...publicFileEdit } = merged;
      this.postTo(session, { type: "fileEdit", ...publicFileEdit });
      return;
    }

    this.postTo(session, {
      type: "toolActivity",
      id: parsed.toolCallId,
      kind: parsed.kind,
      title: parsed.activityTitle ?? parsed.title,
      status: parsed.status ?? "in_progress",
      isUpdate: update.sessionUpdate === "tool_call_update",
    });
  }

  private resolvePath(filePath: string): string {
    if (nodePath.isAbsolute(filePath)) {
      return filePath;
    }
    return nodePath.join(this.workspaceRoot || process.cwd(), filePath);
  }

  private isPathInside(rootPath: string, targetPath: string): boolean {
    const relative = nodePath.relative(rootPath, targetPath);
    return (
      relative === "" ||
      (!relative.startsWith(`..${nodePath.sep}`) && relative !== ".." && !nodePath.isAbsolute(relative))
    );
  }

  private async isSafeWorkspaceMutationPath(filePath: string): Promise<boolean> {
    const configuredRoot = this.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!configuredRoot) {
      return false;
    }

    const lexicalRoot = nodePath.resolve(configuredRoot);
    const resolved = nodePath.resolve(filePath);
    if (!this.isPathInside(lexicalRoot, resolved)) {
      return false;
    }

    try {
      const realRoot = await fs.realpath(lexicalRoot);
      let realTarget: string;
      try {
        realTarget = await fs.realpath(resolved);
      } catch {
        realTarget = await fs.realpath(nodePath.dirname(resolved));
      }
      return this.isPathInside(realRoot, realTarget);
    } catch {
      return false;
    }
  }

  private async loadFilePreview(
    filePath: string
  ): Promise<{ addedLines: number; previewLines: FileEditCardData["previewLines"] } | undefined> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const lines = content.split("\n").slice(0, 12);
      return {
        addedLines: content.split("\n").length,
        previewLines: lines.map((text) => ({ type: "add" as const, text })),
      };
    } catch {
      return undefined;
    }
  }

  private upsertChangeReviewItem(session: ChatSession, fileEdit: FileEditCardData): void {
    const existing = session.changeReviewItems.get(fileEdit.path);
    const next: ChangeReviewItem = {
      ...(existing ?? {
        path: fileEdit.path,
        fileName: fileEdit.fileName,
        previousText: fileEdit.previousText,
      }),
      path: fileEdit.path,
      fileName: fileEdit.fileName,
      status: fileEdit.status,
      addedLines: fileEdit.addedLines || existing?.addedLines || 0,
      removedLines: fileEdit.removedLines || existing?.removedLines || 0,
      previewLines: fileEdit.previewLines.length > 0 ? fileEdit.previewLines : (existing?.previewLines ?? []),
      previousText:
        existing?.previousText !== undefined ? existing.previousText : fileEdit.previousText,
      canRevert: (existing?.previousText !== undefined ? existing.previousText : fileEdit.previousText) !== undefined,
      updatedAt: new Date().toISOString(),
    };
    session.changeReviewItems.set(fileEdit.path, next);
    if (this.isActive(session)) {
      this.postChangeReview();
    }
  }

  private postChangeReview(): void {
    const items = [...(this.active?.changeReviewItems.values() ?? [])].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    ).map(({ previousText: _previousText, ...item }) => item);
    this.post({ type: "changeReview", items });
  }

  private async openFile(filePath: string, line = 1): Promise<void> {
    const resolved = this.resolvePath(filePath);
    try {
      const uri = vscode.Uri.file(resolved);
      const doc = await vscode.workspace.openTextDocument(uri);
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(position, position),
        preview: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", text: this.uiText(`ファイルを開けませんでした: ${message}`, `Failed to open file: ${message}`) });
    }
  }

  private async openDiff(filePath: string): Promise<void> {
    const resolved = this.resolvePath(filePath);
    const item = this.active?.changeReviewItems.get(resolved);
    if (!item || item.previousText === undefined) {
      await this.openFile(resolved);
      return;
    }

    try {
      const storageUri =
        this.extensionContext.globalStorageUri ??
        vscode.Uri.file(nodePath.join(this.extensionContext.globalStoragePath, "review"));
      const baselineDir = vscode.Uri.joinPath(storageUri, "review-baselines");
      await fs.mkdir(baselineDir.fsPath, { recursive: true });
      const safeName = Buffer.from(resolved).toString("base64url");
      const baselineUri = vscode.Uri.joinPath(baselineDir, `${safeName}-${nodePath.basename(resolved)}`);
      await fs.writeFile(baselineUri.fsPath, item.previousText ?? "", "utf8");
      await vscode.commands.executeCommand(
        "vscode.diff",
        baselineUri,
        vscode.Uri.file(resolved),
        `${item.fileName}: before ↔ current`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", text: this.uiText(`差分を開けませんでした: ${message}`, `Failed to open diff: ${message}`) });
    }
  }

  private async revertFile(filePath: string): Promise<void> {
    const resolved = this.resolvePath(filePath);
    const session = this.active;
    const item = session?.changeReviewItems.get(resolved);
    if (!session || !item || item.previousText === undefined) {
      this.post({ type: "error", text: this.uiText("この変更は元内容がないため revert できません", "This change cannot be reverted because its original content is unavailable") });
      return;
    }

    if (!(await this.isSafeWorkspaceMutationPath(resolved))) {
      this.post({ type: "error", text: this.uiText("ワークスペース外のファイルは revert できません", "Files outside the workspace cannot be reverted") });
      return;
    }

    try {
      if (item.previousText === null) {
        await fs.rm(resolved, { force: true });
      } else {
        await fs.writeFile(resolved, item.previousText, "utf8");
      }
      session.changeReviewItems.delete(resolved);
      if (this.isActive(session)) {
        this.postChangeReview();
      }
      this.postTo(session, { type: "system", text: this.uiText(`${item.fileName} を元に戻しました`, `Reverted ${item.fileName}`) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", text: this.uiText(`revert に失敗しました: ${message}`, `Failed to revert: ${message}`) });
    }
  }

  private getPermissionRules(): PermissionRule[] {
    return this.extensionContext.globalState.get<PermissionRule[]>("cursorAgent.permissionRules", []);
  }

  private getPermissionHistory(): PermissionHistoryItem[] {
    return this.extensionContext.globalState.get<PermissionHistoryItem[]>("cursorAgent.permissionHistory", []);
  }

  private async savePermissionHistory(item: Omit<PermissionHistoryItem, "id" | "createdAt">): Promise<void> {
    const next: PermissionHistoryItem[] = [
      {
        ...item,
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        createdAt: new Date().toISOString(),
      },
      ...this.getPermissionHistory(),
    ].slice(0, 30);

    await this.extensionContext.globalState.update("cursorAgent.permissionHistory", next);
    this.postPermissionState();
  }

  private async savePermissionRule(request: PermissionRequestState): Promise<void> {
    const rules = this.getPermissionRules();
    const exists = rules.some(
      (rule) =>
        rule.headline === request.presentation.headline &&
        rule.detail === request.presentation.detail &&
        rule.kind === request.kind
    );
    if (exists) {
      return;
    }

    const next: PermissionRule[] = [
      ...rules,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        headline: request.presentation.headline,
        detail: request.presentation.detail,
        kind: request.kind,
        createdAt: new Date().toISOString(),
      },
    ];
    await this.extensionContext.globalState.update("cursorAgent.permissionRules", next);
  }

  private findPermissionRule(title: string, kind?: string): PermissionRule | undefined {
    const presentation = this.formatPermission(title, kind);
    return this.getPermissionRules().find(
      (rule) =>
        rule.headline === presentation.headline &&
        rule.detail === presentation.detail &&
        rule.kind === kind
    );
  }

  private async removePermissionRule(id: string): Promise<void> {
    const next = this.getPermissionRules().filter((rule) => rule.id !== id);
    await this.extensionContext.globalState.update("cursorAgent.permissionRules", next);
    this.postPermissionState();
  }

  private async clearPermissionHistory(): Promise<void> {
    await this.extensionContext.globalState.update("cursorAgent.permissionHistory", []);
    this.postPermissionState();
  }

  private postPermissionState(): void {
    this.post({
      type: "permissionState",
      rules: this.getPermissionRules(),
      history: this.getPermissionHistory(),
    });
  }

  private findPermissionRequest(id: string): { session: ChatSession; request: PermissionRequestState } | undefined {
    for (const session of this.sessions.values()) {
      const request = session.permissionRequests.get(id);
      if (request) {
        return { session, request };
      }
    }
    return undefined;
  }

  private async resolvePermission(id: string, decision: string): Promise<void> {
    const found = this.findPermissionRequest(id);
    if (!found) {
      return;
    }
    const { session, request } = found;
    session.permissionRequests.delete(id);
    session.forget("permissionRequest", id);
    if (decision === "allow-always") {
      await this.savePermissionRule(request);
    }
    await this.savePermissionHistory({
      headline: request.presentation.headline,
      detail: request.presentation.detail,
      decision,
      autoApproved: false,
    });
    request.resolve(decision === "allow-always" ? "allow-once" : decision);
  }

  private resolvePlan(id: string, outcome: string): void {
    for (const session of this.sessions.values()) {
      const request = session.planRequests.get(id);
      if (!request) {
        continue;
      }
      session.planRequests.delete(id);
      session.forget("planRequest", id);
      request.resolve(outcome === "accepted" ? "accepted" : "rejected");
      if (this.isActive(session)) {
        this.postRunning();
      }
      return;
    }
  }

  private cancelPendingPlans(session: ChatSession): void {
    for (const [id, request] of session.planRequests) {
      session.forget("planRequest", id);
      request.resolve("cancelled");
    }
    session.planRequests.clear();
  }

  // Once a turn is over, nothing should still be waiting for an answer. A
  // leftover plan request would make every later send queue up as an interrupt.
  private settlePendingInteractions(session: ChatSession): void {
    this.cancelPendingPlans(session);
    for (const [id, request] of session.permissionRequests) {
      session.forget("permissionRequest", id);
      request.resolve("reject-once");
    }
    session.permissionRequests.clear();
  }

  private postRunning(): void {
    const session = this.active;
    const turn = session?.turn;
    this.post({
      type: "running",
      running: turn !== undefined,
      stopping: turn?.stopping ?? false,
      waitingForPlan: (session?.planRequests.size ?? 0) > 0 && turn !== undefined && !turn.stopping,
    });
  }

  private formatPermission(title: string, kind?: string): PermissionPresentation {
    const quoted = title.match(/"([^"]+)"/);
    const detail = quoted?.[1] ?? title;

    switch (permissionCategory(title, kind)) {
      case "change":
        return { headline: this.uiText("ファイルの作成・変更", "File creation or change"), detail, icon: "📝" };
      case "command":
        return { headline: this.uiText("コマンドの実行", "Command execution"), detail, icon: "⚡" };
      case "read":
        return { headline: this.uiText("ファイルの読み取り", "File reading"), detail, icon: "🔍" };
      default:
        return { headline: this.uiText("ツールの実行", "Tool execution"), detail, icon: "🔧" };
    }
  }

  private postConfig(): void {
    const session = this.active;
    const config = session?.config;
    if (!session || !config) {
      return;
    }

    const currentMode = config.modes.find((m) => m.id === config.currentModeId);
    const currentModel = config.models.find((m) => m.id === config.currentModelId);

    this.post({
      type: "config",
      ready: true,
      sessionId: session.id,
      modes: config.modes,
      models: config.models,
      modelParameters: config.modelParameters,
      currentModeId: config.currentModeId,
      currentModelId: config.currentModelId,
      currentModeLabel: currentMode?.name ?? config.currentModeId,
      currentModelLabel: formatCurrentModelLabel(
        config.currentModelId,
        currentModel?.name,
        config.modelParameters
      ),
      currentModeIcon: MODE_ICONS[config.currentModeId] ?? "∞",
      autoApprovePermissions: this.getAutoApprovePermissions(),
      busy: session.turn !== undefined,
    });
    this.post({ type: "init", status: "ready" });
    void this.handleRequestUsage(false);
  }

  private async handleRequestUsage(force: boolean): Promise<void> {
    const cacheAge = Date.now() - this.usageFetchedAt;
    if (!force && this.usageCache && cacheAge < USAGE_CACHE_TTL_MS) {
      this.post({ type: "usage", status: "ready", usage: this.usageCache });
      return;
    }

    if (this.usageInFlight) {
      await this.usageInFlight;
      return;
    }

    this.post({ type: "usage", status: "loading", usage: this.usageCache });
    this.usageInFlight = (async () => {
      try {
        const usage = await fetchCursorUsage();
        this.usageCache = usage;
        this.usageFetchedAt = Date.now();
        this.post({ type: "usage", status: "ready", usage });
      } catch (err) {
        const message =
          err instanceof UsageError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        this.post({
          type: "usage",
          status: "error",
          usage: this.usageCache,
          message: this.uiText(
            `使用量の取得に失敗しました: ${message}`,
            `Failed to load usage: ${message}`
          ),
        });
      } finally {
        this.usageInFlight = undefined;
      }
    })();

    await this.usageInFlight;
  }

  private bindClientEvents(client: AcpClient): void {
    client.on("update", (sessionId: string | undefined, update: Record<string, unknown>) => {
      const session = this.sessionFor(sessionId);
      if (!session || !update) {
        return;
      }

      const sessionUpdate = update.sessionUpdate as string | undefined;
      const text = extractUpdateText(update.content);

      if (isUserMessageUpdate(sessionUpdate) && text) {
        if (session.isAssistantOpen && !session.turn) {
          this.postTo(session, { type: "assistantDone", stopReason: "replay" });
        }
        this.postTo(session, { type: "userMessage", text });
        return;
      }

      if (isAgentMessageUpdate(sessionUpdate) && text) {
        if (!session.isAssistantOpen) {
          this.postTo(session, { type: "assistantStart" });
        }
        this.postTo(session, { type: "assistantChunk", text });
        return;
      }

      if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
        void this.handleToolUpdate(session, update);
        return;
      }

      if (sessionUpdate === "agent_thought_chunk" && text) {
        this.postTo(session, { type: "thinking", text, append: true });
      }
    });

    client.on(
      "permission",
      async ({
        sessionId,
        title,
        kind,
        resolve,
      }: {
        sessionId?: string;
        title: string;
        kind?: string;
        resolve: (v: string) => void;
      }) => {
        const session = this.sessionFor(sessionId);
        if (!session) {
          resolve("reject-once");
          return;
        }

        const presentation = this.formatPermission(title, kind);
        const rule = this.findPermissionRule(title, kind);
        if (rule) {
          await this.savePermissionHistory({
            headline: presentation.headline,
            detail: presentation.detail,
            decision: "allow-once",
            autoApproved: true,
          });
          resolve("allow-once");
          return;
        }

        // A session in the background keeps the card until the user returns to it.
        const id = String(++this.permissionCounter);
        session.permissionRequests.set(id, { resolve, title, kind, presentation });
        this.postTo(session, {
          type: "permissionRequest",
          id,
          title: presentation.headline,
          detail: presentation.detail,
          icon: presentation.icon,
        });
      }
    );

    client.on(
      "askQuestion",
      async ({
        sessionId,
        title,
        questions,
        signal,
        resolve,
      }: {
        sessionId?: string;
        title?: string;
        questions: Array<{
          id: string;
          prompt: string;
          options: Array<{ id: string; label: string }>;
          allowMultiple?: boolean;
        }>;
        signal: AbortSignal;
        resolve: (answers: Array<{ questionId: string; selectedOptionIds: string[] }>) => void;
      }) => {
        // Questions open a picker over the editor; do not ask on behalf of a chat that is not shown.
        const session = this.sessionFor(sessionId);
        if (!session || !this.isActive(session)) {
          resolve([]);
          return;
        }

        const answers: Array<{ questionId: string; selectedOptionIds: string[] }> = [];

        for (const q of questions) {
          const picked = await this.pickQuestionOptions(q, title, signal);
          if (!picked) {
            resolve([]);
            return;
          }

          answers.push({ questionId: q.id, selectedOptionIds: picked });
        }

        resolve(answers);
      }
    );

    client.on(
      "createPlan",
      ({
        sessionId,
        name,
        overview,
        plan,
        todos,
        resolve,
      }: {
        sessionId?: string;
        name?: string;
        overview?: string;
        plan?: string;
        todos?: PlanTodo[];
        resolve: (outcome: string) => void;
      }) => {
        const session = this.sessionFor(sessionId);
        if (!session) {
          resolve("cancelled");
          return;
        }

        const id = String(++this.planCounter);
        session.planRequests.set(id, { resolve });
        this.postTo(session, {
          type: "planRequest",
          id,
          name: name ?? this.uiText("プラン", "Plan"),
          overview: overview ?? "",
          plan: plan ?? "",
          todos: todos ?? [],
        });
        if (this.isActive(session)) {
          this.view?.show?.(true);
          this.postRunning();
        }
      }
    );

    client.on("cancelled", (sessionId: string) => {
      const session = this.sessions.get(sessionId);
      if (session?.turn?.stopping) {
        this.finishCancel(session);
      }
    });

    client.on("log", (text: string) => {
      this.output.appendLine(`[${new Date().toISOString()}] ${text}`);
    });

    client.on("exit", (code) => {
      this.output.appendLine(`[${new Date().toISOString()}] agent process exited (code: ${code})`);
      // A client we disposed on purpose exits after its replacement is already
      // connected; it must not tear the new one down.
      if (this.client !== client) {
        return;
      }

      this.post({ type: "error", text: this.uiText(`エージェントプロセスが終了しました (code: ${code})`, `The agent process exited (code: ${code})`) });
      this.client = undefined;
      for (const session of this.sessions.values()) {
        if (session.turn) {
          session.turn = undefined;
          this.settlePendingInteractions(session);
          this.postTo(session, { type: "assistantDone", stopReason: "error" });
        }
      }
      // The thread stays on screen; the next message starts a new session.
      this.forgetSessions();
      this.postQueue();
      this.postRunning();
      this.setRunningContext(false);
    });
  }

  private pickQuestionOptions(
    question: { prompt: string; options: Array<{ id: string; label: string }>; allowMultiple?: boolean },
    title: string | undefined,
    signal: AbortSignal
  ): Promise<string[] | undefined> {
    if (signal.aborted) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
      pick.items = question.options.map((o) => ({ label: o.label, id: o.id }));
      pick.title = title ?? question.prompt;
      pick.placeholder = question.prompt;
      pick.ignoreFocusOut = true;
      pick.canSelectMany = question.allowMultiple === true;

      let settled = false;
      const finish = (ids: string[] | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        pick.dispose();
        resolve(ids && ids.length > 0 ? ids : undefined);
      };
      // The agent stopped waiting (the turn was cancelled), so close the picker.
      const onAbort = () => finish(undefined);
      signal.addEventListener("abort", onAbort);

      pick.onDidAccept(() => {
        const items = pick.canSelectMany ? pick.selectedItems : pick.activeItems;
        finish(items.map((item) => item.id));
      });
      pick.onDidHide(() => finish(undefined));
      pick.show();
    });
  }

  private async handleCancel(): Promise<void> {
    const session = this.active;
    const turn = session?.turn;
    if (!session || !turn || turn.stopping) {
      return;
    }

    this.cancelPendingPlans(session);
    turn.stopping = true;
    this.postRunning();

    if (!this.client) {
      this.finishCancel(session);
      return;
    }

    try {
      await this.client.cancel(session.id);
    } catch (err) {
      if (session.turn !== turn) {
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      this.postTo(session, { type: "error", text: this.uiText(`停止に失敗しました: ${message}`, `Failed to stop: ${message}`) });
      this.endTurn(session, "error");
    }
  }

  private endTurn(session: ChatSession, stopReason: string): void {
    session.turn = undefined;
    this.settlePendingInteractions(session);
    this.postTo(session, { type: "assistantDone", stopReason, endedAt: Date.now() });
    if (this.isActive(session)) {
      this.postRunning();
      this.setRunningContext(false);
      this.postConfig();
    }
  }

  private finishCancel(session: ChatSession): void {
    const turn = session.turn;
    if (!turn) {
      return;
    }

    session.turn = undefined;
    this.settlePendingInteractions(session);
    this.postTo(session, { type: "cancelled" });
    this.postTo(session, { type: "assistantDone", stopReason: "cancelled" });
    if (this.isActive(session)) {
      this.postRunning();
      this.setRunningContext(false);
      this.postConfig();
    }

    if (turn.drainAfterCancel) {
      void this.drainQueue(session);
    }
  }

  private async handleRequestSuggestions(kind: "file" | "slash", query: string): Promise<void> {
    const root = this.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const items =
      kind === "file" ? await searchFileItems(query, root) : await searchSlashItems(query, root);

    this.post({
      type: "suggestions",
      kind,
      query,
      items,
    });
  }

  private async handleRequestContextPreview(text: string): Promise<void> {
    const root = this.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    try {
      const items = await getPromptContextPreview(text, root, this.locale);
      this.post({ type: "contextPreview", text, items });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "contextPreview", text, items: [], error: message });
    }
  }

  private async handleSend(text: string, images?: PromptImageAttachment[]): Promise<void> {
    const trimmed = text.trim();
    const sanitizedImages = sanitizeImageAttachments(images);
    if (!trimmed && sanitizedImages.length === 0) {
      return;
    }

    if (!this.active) {
      // The agent process went away; reconnecting starts a new session.
      try {
        await this.ensureClient();
      } catch {
        return;
      }
    }
    const session = this.active;
    if (!session) {
      return;
    }

    if (session.planRequests.size > 0) {
      await this.interruptWithPrompt(session, trimmed, sanitizedImages);
      return;
    }

    if (session.turn) {
      this.enqueuePrompt(session, trimmed, sanitizedImages);
      return;
    }

    await this.sendNow(session, trimmed, sanitizedImages);
  }

  private async interruptWithPrompt(session: ChatSession, text: string, images: PromptImageAttachment[]): Promise<void> {
    session.queue.unshift({
      id: `q-${++this.queueSeq}`,
      text,
      images,
      kind: "interrupt",
    });
    this.postQueue();
    if (!session.turn) {
      await this.drainQueue(session);
      return;
    }
    session.turn.drainAfterCancel = true;
    if (!session.turn.stopping) {
      await this.handleCancel();
    }
  }

  private enqueuePrompt(session: ChatSession, text: string, images: PromptImageAttachment[]): void {
    session.queue.push({
      id: `q-${++this.queueSeq}`,
      text,
      images,
      kind: "queue",
    });
    this.postQueue();
  }

  private removeQueuedPrompt(id: string): void {
    const session = this.active;
    if (!session) {
      return;
    }
    const next = session.queue.filter((item) => item.id !== id);
    if (next.length === session.queue.length) {
      return;
    }
    session.queue = next;
    this.postQueue();
  }

  private async sendQueuedPrompt(id: string): Promise<void> {
    const session = this.active;
    if (!session) {
      return;
    }
    const index = session.queue.findIndex((item) => item.id === id);
    if (index < 0) {
      return;
    }

    const [item] = session.queue.splice(index, 1);

    if (session.turn) {
      session.queue.unshift({ ...item, kind: "interrupt" });
      this.postQueue();
      session.turn.drainAfterCancel = true;
      if (!session.turn.stopping) {
        await this.handleCancel();
      }
      return;
    }

    this.postQueue();
    await this.sendNow(session, item.text, item.images);
  }

  private postQueue(): void {
    this.post({
      type: "promptQueue",
      items: (this.active?.queue ?? []).map((item) => ({
        id: item.id,
        text: item.text,
        kind: item.kind,
        imageCount: item.images.length,
      })),
    });
  }

  private async drainQueue(session: ChatSession): Promise<void> {
    if (session.turn) {
      return;
    }

    const next = session.queue.shift();
    if (this.isActive(session)) {
      this.postQueue();
    }
    if (!next) {
      return;
    }

    await this.sendNow(session, next.text, next.images);
  }

  private async sendNow(session: ChatSession, text: string, images: PromptImageAttachment[]): Promise<void> {
    const client = this.client;
    if (session.turn || (!text && images.length === 0)) {
      return;
    }
    if (!client || client.isDisposed || this.sessions.get(session.id) !== session) {
      return;
    }

    const turn: Turn = { stopping: false, drainAfterCancel: false };
    session.turn = turn;
    this.postTo(session, { type: "userMessage", text, images });
    this.postTo(session, { type: "assistantStart", startedAt: Date.now() });
    if (this.isActive(session)) {
      this.setRunningContext(true);
      this.postRunning();
      this.postConfig();
    }

    try {
      const root = this.workspaceRoot || process.cwd();
      const promptBlocks = await buildPromptBlocks(text, root, images);
      // Stopped while the prompt was being prepared.
      if (session.turn !== turn) {
        return;
      }
      const result = await client.prompt(session.id, promptBlocks);

      if (session.turn !== turn) {
        return;
      }

      if (turn.stopping || result.stopReason === "cancelled" || result.stopReason === "canceled") {
        this.finishCancel(session);
        return;
      }

      this.endTurn(session, result.stopReason);
      await this.drainQueue(session);
    } catch (err) {
      if (session.turn !== turn) {
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      if (turn.stopping || message === "cancelled") {
        this.finishCancel(session);
        return;
      }

      this.postTo(session, { type: "error", text: message });
      this.endTurn(session, "error");
    }
  }

  private setRunningContext(running: boolean): void {
    void vscode.commands.executeCommand("setContext", "cursorAgent.running", running);
  }

  /** Records a message in the session's thread and shows it if the session is on screen. */
  private postTo(session: ChatSession, message: ThreadMessage): void {
    session.record(message);
    if (this.isActive(session)) {
      this.post(message);
    }
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.js"));
    const nonce = getNonce();
    const language = this.locale;

    return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: blob:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Cursor Agent</title>
</head>
<body>
  <div class="top-bar">
    <button id="historyBtn" class="top-btn history-btn" type="button" title="${this.uiText("チャット履歴", "Chat history")}" disabled>
      <svg class="btn-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5"/>
        <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span id="historyLabel">${this.uiText("履歴", "History")}</span>
      <span class="pill-chevron">▾</span>
    </button>
    <div class="top-actions">
      <button id="usageBtn" class="top-btn" type="button" title="${this.uiText("Cursor 使用量", "Cursor usage")}">
        <span id="usageLabel">${this.uiText("使用量", "Usage")}</span>
        <span class="pill-chevron">▾</span>
      </button>
      <button id="changesBtn" class="top-btn" type="button" title="${this.uiText("変更レビュー", "Change review")}">${this.uiText("変更", "Changes")}</button>
      <button id="permissionsBtn" class="top-btn" type="button" title="${this.uiText("権限ルール", "Permission rules")}">${this.uiText("権限", "Permissions")}</button>
      <button id="newChat" class="top-btn new-chat-btn" type="button" title="${this.uiText("新しいチャット", "New chat")}">
        <svg class="btn-svg" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
        <span>New Chat</span>
      </button>
    </div>
  </div>
  <div id="historyMenu" class="picker-menu picker-menu-wide hidden" role="menu"></div>
  <div id="usageMenu" class="picker-menu picker-menu-wide usage-menu hidden" role="menu"></div>
  <div id="changesMenu" class="picker-menu picker-menu-wide changes-menu hidden" role="menu"></div>
  <div id="permissionsMenu" class="picker-menu picker-menu-wide permission-menu hidden" role="menu"></div>
  <div id="bootOverlay" class="boot-overlay">
    <div class="boot-card">
      <div class="boot-main">
        <span class="boot-spinner"></span>
        <span id="bootLabel">${this.uiText("エージェントに接続中...", "Connecting to the agent...")}</span>
      </div>
      <div id="bootActions" class="boot-actions hidden">
        <button id="retryConnectBtn" class="boot-action" type="button">${this.uiText("再接続", "Reconnect")}</button>
        <button id="diagnoseBtn" class="boot-action" type="button">${this.uiText("診断", "Diagnostics")}</button>
        <button id="openSettingsBtn" class="boot-action" type="button">${this.uiText("設定", "Settings")}</button>
      </div>
      <div id="diagnosticsPanel" class="diagnostics-panel hidden"></div>
    </div>
  </div>
  <div class="thread-wrap">
    <main id="thread" class="thread"></main>
    <div id="emptyState" class="empty-state">
      <div class="empty-title">Cursor Agent</div>
      <div class="empty-sub">${this.uiText("コードについて質問したり、編集やタスクを依頼できます", "Ask about your code, request edits, or assign tasks")}</div>
      <ul class="empty-hints">
        <li><kbd>@</kbd><span>${this.uiText("ファイル・フォルダをコンテキストに追加", "Add files and folders as context")}</span></li>
        <li><kbd>/</kbd><span>${this.uiText("コマンド・スキルを呼び出す", "Invoke commands and skills")}</span></li>
        <li><kbd>Shift</kbd><span class="kbd-plus">+</span><kbd>Enter</kbd><span>${this.uiText("改行を挿入", "Insert a new line")}</span></li>
        <li><kbd>Enter</kbd><span>${this.uiText("実行中はキューに追加", "While running, add to the queue")}</span></li>
      </ul>
    </div>
    <button id="jumpBottom" class="jump-bottom hidden" type="button" title="${this.uiText("最新のメッセージへ", "Jump to the latest message")}">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  </div>
  <div id="taskStatus" class="task-status hidden" role="status">
    <span class="task-label">
      <span class="task-spinner"></span>
      <span id="taskLabel">${this.uiText("エージェント実行中...", "Agent is running...")}</span>
    </span>
  </div>
  <footer class="composer-dock">
    <div id="modeMenu" class="picker-menu hidden" role="menu"></div>
    <div id="modelMenu" class="picker-menu picker-menu-wide hidden" role="menu"></div>
    <div id="suggestMenu" class="suggest-menu hidden" role="listbox"></div>
    <div class="composer-card">
      <div id="contextTray" class="context-tray hidden" aria-label="${this.uiText("添付コンテキスト", "Attached context")}"></div>
      <div id="attachmentTray" class="attachment-tray hidden" aria-label="${this.uiText("添付画像", "Attached images")}"></div>
      <div id="queueTray" class="queue-tray hidden" aria-label="${this.uiText("送信キュー", "Send queue")}"></div>
      <textarea id="input" rows="1" placeholder="${this.uiText("質問や指示を入力（@ でコンテキスト、画像貼り付け可）", "Ask a question or enter an instruction (@ for context, paste images)")}"></textarea>
      <div class="composer-footer">
        <div class="composer-meta">
          <button id="modePill" class="pill" type="button" title="${this.uiText("モード", "Mode")}">
            <span class="pill-icon">∞</span>
            <span class="pill-label">Agent</span>
            <span class="pill-chevron">▾</span>
          </button>
          <button id="modelPill" class="pill pill-model" type="button" title="${this.uiText("モデル", "Model")}">
            <span class="pill-label">Auto</span>
            <span class="pill-chevron">▾</span>
          </button>
          <button
            id="autoRunPill"
            class="pill pill-autorun"
            type="button"
            title="${this.uiText("自動実行 OFF — クリックで ON（--yolo 相当）", "Auto-run OFF — click to enable (--yolo equivalent)")}"
            aria-pressed="false"
            disabled
          >
            <span class="pill-icon">⚡</span>
            <span class="pill-label">Auto-run</span>
          </button>
        </div>
        <div class="composer-actions">
          <span id="footerSpinner" class="footer-spinner hidden"></span>
          <button id="stopBtn" class="icon-btn stop-btn-round hidden" type="button" title="${this.uiText("停止", "Stop")}">
            <span class="stop-icon"></span>
          </button>
          <button id="send" class="icon-btn send-btn" type="button" title="${this.uiText("送信 (Enter)", "Send (Enter)")}">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </footer>
  <div id="imageLightbox" class="image-lightbox hidden" aria-hidden="true" role="dialog" aria-modal="true" aria-label="${this.uiText("画像プレビュー", "Image preview")}">
    <button id="imageLightboxClose" class="image-lightbox-close" type="button" title="${this.uiText("閉じる", "Close")}" aria-label="${this.uiText("閉じる", "Close")}">×</button>
    <img id="imageLightboxImg" class="image-lightbox-img" alt="" />
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
