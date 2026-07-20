import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { AcpClient, AgentMode, validateAgentPath } from "./acpClient";
import { AcpSessionInfo, formatModelDisplayName, SessionPickerConfig } from "./sessionConfig";
import { searchFileItems, searchSlashItems } from "./contextCatalog";
import { buildPromptBlocks, getPromptContextPreview, PromptImageAttachment } from "./promptBuilder";
import { loadSessionHistory, SessionHistoryMessage } from "./sessionHistory";
import { FileEditCardData, parseToolUpdate } from "./toolCallParser";

type WebviewMessage =
  | { type: "send"; text: string; images?: PromptImageAttachment[] }
  | { type: "requestSuggestions"; kind: "file" | "slash"; query: string }
  | { type: "requestContextPreview"; text: string }
  | { type: "newChat" }
  | { type: "cancel" }
  | { type: "setMode"; modeId: AgentMode }
  | { type: "setModel"; modelId: string }
  | { type: "permissionResponse"; id: string; decision: string }
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
  | { type: "runDiagnostics" }
  | { type: "ready" };

interface PermissionPresentation {
  headline: string;
  detail: string;
  icon: string;
}

interface PermissionRequestState {
  resolve: (decision: string) => void;
  title: string;
  kind?: string;
  presentation: PermissionPresentation;
}

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

interface ChangeReviewItem {
  path: string;
  fileName: string;
  status: string;
  addedLines: number;
  removedLines: number;
  previewLines: FileEditCardData["previewLines"];
  previousText?: string | null;
  canRevert: boolean;
  updatedAt: string;
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
  private busy = false;
  private stopping = false;
  private mode: AgentMode = "agent";
  private modelId = "default[]";
  private sessionConfig?: SessionPickerConfig;
  private permissionRequests = new Map<string, PermissionRequestState>();
  private permissionCounter = 0;
  private fileEdits = new Map<string, FileEditCardData>();
  private changeReviewItems = new Map<string, ChangeReviewItem>();
  private workspaceRoot = "";
  private replayAssistantOpen = false;
  private replayingSession = false;
  private replayBuffer: Record<string, unknown>[] = [];
  private connectPromise?: Promise<void>;
  private connectEpoch = 0;
  private configSubscription?: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionContext: vscode.ExtensionContext
  ) {
    this.mode = extensionContext.globalState.get<AgentMode>("cursorAgent.mode", "agent");
    this.modelId = extensionContext.globalState.get<string>("cursorAgent.modelId", "default[]");
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
        case "ready":
          await this.ensureClient();
          break;
        case "send":
          await this.handleSend(msg.text, msg.images);
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
        case "permissionResponse":
          await this.resolvePermission(msg.id, msg.decision);
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
          this.changeReviewItems.clear();
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
    });
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
    return this.busy;
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

  private async applySessionConfig(config: SessionPickerConfig): Promise<void> {
    this.sessionConfig = config;
    this.mode = config.currentModeId;
    this.modelId = config.currentModelId;
    await this.savePreferences();
    this.postConfig();
  }

  private async createClientSession(client: AcpClient, epoch: number): Promise<boolean> {
    if (epoch !== this.connectEpoch || this.client !== client || client.isDisposed) {
      return false;
    }

    const config = await client.newSession(this.mode, this.modelId);
    if (epoch !== this.connectEpoch || this.client !== client || client.isDisposed) {
      return false;
    }

    await this.applySessionConfig(config);
    return true;
  }

  private abandonClient(client: AcpClient): void {
    client.dispose();
    if (this.client === client) {
      this.client = undefined;
    }
  }

  private async connectClient(): Promise<void> {
    const epoch = this.connectEpoch;
    this.post({ type: "init", status: "loading", message: this.uiText("エージェントに接続中...", "Connecting to the agent...") });

    const config = vscode.workspace.getConfiguration("cursorAgent");
    const agentPath = config.get<string>("agentPath", "agent");
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

      const applied = await this.createClientSession(client, epoch);
      if (!applied) {
        return;
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

  private async handleRetryConnect(): Promise<void> {
    if (this.busy) {
      return;
    }

    this.connectEpoch++;
    this.connectPromise = undefined;
    this.client?.dispose();
    this.client = undefined;
    this.sessionConfig = undefined;
    await this.ensureClient().catch(() => undefined);
  }

  private async handleRunDiagnostics(): Promise<void> {
    const config = vscode.workspace.getConfiguration("cursorAgent");
    const agentPath = config.get<string>("agentPath", "agent");
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
        currentSessionId: this.client.currentSessionId,
      });
    } catch {
      // ignore list failures
    }
  }

  private async handleSelectSession(sessionId: string): Promise<void> {
    if (this.busy || !sessionId) {
      return;
    }

    if (this.client?.currentSessionId === sessionId) {
      return;
    }

    try {
      await this.ensureClient();
      if (!this.client?.canLoadSession) {
        this.post({ type: "error", text: this.uiText("このエージェントは履歴の読み込みに対応していません", "This agent does not support loading session history") });
        return;
      }

      this.replayAssistantOpen = false;
      this.fileEdits.clear();
      this.changeReviewItems.clear();
      this.replayBuffer = [];
      this.post({ type: "clear" });
      this.postChangeReview();
      this.post({ type: "sessionLoading", title: this.uiText("チャットを読み込み中...", "Loading chat...") });

      this.replayingSession = true;
      try {
        this.sessionConfig = await this.client.loadSession(sessionId);
      } finally {
        this.replayingSession = false;
      }

      let hasHistory = this.replayBuffer.some(
        (message) => message.type === "userMessage" || message.type === "assistantChunk"
      );
      this.flushReplayBuffer();
      this.finishReplayTurn();

      if (!hasHistory) {
        const localHistory = await loadSessionHistory(sessionId);
        if (localHistory.length > 0) {
          this.replayLocalHistory(localHistory);
          hasHistory = true;
        }
      }

      this.mode = this.sessionConfig.currentModeId;
      this.modelId = this.sessionConfig.currentModelId;
      await this.savePreferences();
      this.postConfig();
      this.post({ type: "sessionLoaded", emptyHistory: !hasHistory });
      await this.refreshSessions();
    } catch (err) {
      this.replayingSession = false;
      this.replayBuffer = [];
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", text: this.uiText(`チャットの読み込みに失敗: ${message}`, `Failed to load chat: ${message}`) });
      this.post({ type: "sessionLoaded" });
    }
  }

  private finishReplayTurn(): void {
    if (!this.replayAssistantOpen) {
      return;
    }

    this.post({ type: "assistantDone", stopReason: "replay" });
    this.replayAssistantOpen = false;
  }

  private replayLocalHistory(messages: SessionHistoryMessage[]): void {
    let assistantOpen = false;

    for (const message of messages) {
      if (message.role === "user") {
        if (assistantOpen) {
          this.post({ type: "assistantDone", stopReason: "replay" });
          assistantOpen = false;
        }
        this.post({ type: "userMessage", text: message.text });
        continue;
      }

      if (!assistantOpen) {
        this.post({ type: "assistantStart" });
        assistantOpen = true;
      }
      this.post({ type: "assistantChunk", text: message.text });
    }

    if (assistantOpen) {
      this.post({ type: "assistantDone", stopReason: "replay" });
    }
  }

  private async handleSetMode(modeId: AgentMode): Promise<void> {
    if (this.busy) {
      return;
    }

    try {
      await this.ensureClient();
      this.sessionConfig = await this.client!.setMode(modeId);
      this.mode = this.sessionConfig.currentModeId;
      await this.savePreferences();
      this.postConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", text: this.uiText(`モード変更に失敗: ${message}`, `Failed to change mode: ${message}`) });
    }
  }

  private async handleSetModel(modelId: string): Promise<void> {
    if (this.busy) {
      return;
    }

    try {
      await this.ensureClient();
      this.sessionConfig = await this.client!.setModel(modelId);
      this.modelId = this.sessionConfig.currentModelId;
      await this.savePreferences();
      this.postConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", text: this.uiText(`モデル変更に失敗: ${message}`, `Failed to change model: ${message}`) });
    }
  }

  private async savePreferences(): Promise<void> {
    await this.extensionContext.globalState.update("cursorAgent.mode", this.mode);
    await this.extensionContext.globalState.update("cursorAgent.modelId", this.modelId);
  }

  private async handleToolUpdate(update: Record<string, unknown>): Promise<void> {
    const parsed = parseToolUpdate(update);
    if (!parsed) {
      return;
    }

    if (parsed.fileEdit) {
      const existing = this.fileEdits.get(parsed.fileEdit.id);
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

      this.fileEdits.set(merged.id, merged);
      this.upsertChangeReviewItem(merged);
      const { previousText: _previousText, nextText: _nextText, ...publicFileEdit } = merged;
      this.post({ type: "fileEdit", ...publicFileEdit });
      return;
    }

    this.post({
      type: "toolActivity",
      id: parsed.toolCallId,
      title: parsed.activityTitle ?? parsed.title ?? this.uiText("ツール", "Tool"),
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

  private upsertChangeReviewItem(fileEdit: FileEditCardData): void {
    const existing = this.changeReviewItems.get(fileEdit.path);
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
    this.changeReviewItems.set(fileEdit.path, next);
    this.postChangeReview();
  }

  private postChangeReview(): void {
    const items = [...this.changeReviewItems.values()].sort(
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
    const item = this.changeReviewItems.get(resolved);
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
    const item = this.changeReviewItems.get(resolved);
    if (!item || item.previousText === undefined) {
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
      this.changeReviewItems.delete(resolved);
      this.postChangeReview();
      this.post({ type: "system", text: this.uiText(`${item.fileName} を元に戻しました`, `Reverted ${item.fileName}`) });
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

  private async resolvePermission(id: string, decision: string): Promise<void> {
    const request = this.permissionRequests.get(id);
    if (!request) {
      return;
    }
    this.permissionRequests.delete(id);
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

  private formatPermission(title: string, kind?: string): PermissionPresentation {
    const quoted = title.match(/"([^"]+)"/);
    const path = quoted?.[1] ?? title;
    const lower = `${kind ?? ""} ${title}`.toLowerCase();

    if (lower.includes("write") || lower.includes("edit") || lower.includes("create") || /\.(bat|sh|ps1|js|ts|py|md|json)/i.test(path)) {
      return { headline: this.uiText("ファイルの作成・変更", "File creation or change"), detail: path, icon: "📝" };
    }
    if (lower.includes("run") || lower.includes("exec") || lower.includes("command") || lower.includes("shell")) {
      return { headline: this.uiText("コマンドの実行", "Command execution"), detail: path, icon: "⚡" };
    }
    if (lower.includes("read") || lower.includes("glob") || lower.includes("search")) {
      return { headline: this.uiText("ファイルの読み取り", "File reading"), detail: path, icon: "🔍" };
    }

    return { headline: this.uiText("ツールの実行", "Tool execution"), detail: path, icon: "🔧" };
  }

  private postConfig(): void {
    if (!this.sessionConfig) {
      return;
    }

    const currentMode = this.sessionConfig.modes.find((m) => m.id === this.sessionConfig!.currentModeId);
    const currentModel = this.sessionConfig.models.find((m) => m.id === this.sessionConfig!.currentModelId);

    this.post({
      type: "config",
      ready: true,
      sessionId: this.client?.currentSessionId ?? this.sessionConfig.sessionId,
      modes: this.sessionConfig.modes,
      models: this.sessionConfig.models,
      currentModeId: this.sessionConfig.currentModeId,
      currentModelId: this.sessionConfig.currentModelId,
      currentModeLabel: currentMode?.name ?? this.sessionConfig.currentModeId,
      currentModelLabel: currentModel?.name ?? formatModelDisplayName(this.sessionConfig.currentModelId, ""),
      currentModeIcon: MODE_ICONS[this.sessionConfig.currentModeId] ?? "∞",
      autoApprovePermissions: this.getAutoApprovePermissions(),
      busy: this.busy,
    });
    this.post({ type: "init", status: "ready" });
  }

  private bindClientEvents(client: AcpClient): void {
    client.on("update", (update) => {
      const sessionUpdate = update.sessionUpdate as string | undefined;
      const text = extractUpdateText(update.content);

      if (isUserMessageUpdate(sessionUpdate) && text) {
        this.finishReplayTurn();
        this.post({ type: "userMessage", text });
        return;
      }

      if (isAgentMessageUpdate(sessionUpdate) && text) {
        if (!this.busy && !this.replayAssistantOpen) {
          if (!this.replayingSession) {
            this.post({ type: "assistantStart" });
          }
          this.replayAssistantOpen = true;
        }
        this.post({ type: "assistantChunk", text });
        return;
      }

      if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
        void this.handleToolUpdate(update);
        return;
      }

      if (sessionUpdate === "agent_thought_chunk" && text) {
        this.post({ type: "thinking", text, append: true });
      }
    });

    client.on(
      "permission",
      async ({ title, kind, resolve }: { title: string; kind?: string; resolve: (v: string) => void }) => {
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

        const id = String(++this.permissionCounter);
        this.permissionRequests.set(id, { resolve, title, kind, presentation });
        this.post({
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
        title,
        questions,
        resolve,
      }: {
        title?: string;
        questions: Array<{
          id: string;
          prompt: string;
          options: Array<{ id: string; label: string }>;
        }>;
        resolve: (answers: Array<{ questionId: string; selectedOptionIds: string[] }>) => void;
      }) => {
        const answers: Array<{ questionId: string; selectedOptionIds: string[] }> = [];

        for (const q of questions) {
          const picked = await vscode.window.showQuickPick(
            q.options.map((o) => ({ label: o.label, id: o.id })),
            {
              title: title ?? q.prompt,
              placeHolder: q.prompt,
              ignoreFocusOut: true,
            }
          );

          if (!picked) {
            resolve([]);
            return;
          }

          answers.push({ questionId: q.id, selectedOptionIds: [picked.id] });
        }

        resolve(answers);
      }
    );

    client.on(
      "createPlan",
      async ({
        name,
        overview,
        plan,
        resolve,
      }: {
        name?: string;
        overview?: string;
        plan?: string;
        resolve: (outcome: string) => void;
      }) => {
        const doc = await vscode.workspace.openTextDocument({
          content: `# ${name ?? "Plan"}\n\n${overview ? `## Overview\n${overview}\n\n` : ""}${plan ?? ""}`,
          language: "markdown",
        });
        await vscode.window.showTextDocument(doc, { preview: true });

        const choice = await vscode.window.showInformationMessage(
          this.uiText("プランを承認しますか？", "Do you approve this plan?"),
          { modal: true },
          this.uiText("承認", "Approve"),
          this.uiText("拒否", "Reject")
        );

        resolve(choice === this.uiText("承認", "Approve") ? "accepted" : "rejected");
      }
    );

    client.on("cancelled", () => {
      if (this.stopping) {
        this.finishCancel();
      }
    });

    client.on("exit", (code) => {
      this.post({ type: "error", text: this.uiText(`エージェントプロセスが終了しました (code: ${code})`, `The agent process exited (code: ${code})`) });
      this.client = undefined;
      this.busy = false;
      this.stopping = false;
      this.post({ type: "running", running: false });
      this.setRunningContext(false);
    });
  }

  private async handleCancel(): Promise<void> {
    if (!this.busy || this.stopping) {
      return;
    }

    this.stopping = true;
    this.post({ type: "running", running: true, stopping: true });

    try {
      await this.client?.cancel();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", text: this.uiText(`停止に失敗しました: ${message}`, `Failed to stop: ${message}`) });
      this.stopping = false;
      this.busy = false;
      this.post({ type: "running", running: false });
      this.setRunningContext(false);
      this.post({ type: "assistantDone", stopReason: "error" });
      this.postConfig();
    }
  }

  private finishCancel(): void {
    if (!this.busy && !this.stopping) {
      return;
    }

    this.stopping = false;
    this.busy = false;
    this.post({ type: "cancelled" });
    this.post({ type: "assistantDone", stopReason: "cancelled" });
    this.post({ type: "running", running: false });
    this.setRunningContext(false);
    this.postConfig();
  }

  private async handleNewChat(): Promise<void> {
    this.connectEpoch++;
    const pendingConnect = this.connectPromise;
    this.connectPromise = undefined;

    if (pendingConnect) {
      await pendingConnect.catch(() => undefined);
    }

    this.sessionConfig = undefined;
    this.permissionRequests.clear();
    this.fileEdits.clear();
    this.changeReviewItems.clear();
    this.busy = false;
    this.stopping = false;
    this.setRunningContext(false);
    this.replayAssistantOpen = false;
    this.post({ type: "clear" });
    this.postChangeReview();
    this.post({ type: "init", status: "loading", message: this.uiText("新しいチャットを準備中...", "Preparing a new chat...") });

    const epoch = this.connectEpoch;

    try {
      if (!this.client || this.client.isDisposed) {
        await this.ensureClient();
        return;
      }

      const applied = await this.createClientSession(this.client, epoch);
      if (!applied) {
        return;
      }

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

      this.connectPromise = undefined;
      await this.ensureClient();
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
    if ((!trimmed && sanitizedImages.length === 0) || this.busy) {
      return;
    }

    try {
      await this.ensureClient();
    } catch {
      return;
    }

    const root = this.workspaceRoot || process.cwd();
    const promptBlocks = await buildPromptBlocks(trimmed, root, sanitizedImages);

    this.busy = true;
    this.stopping = false;
    this.setRunningContext(true);
    this.post({ type: "userMessage", text: trimmed, images: sanitizedImages });
    this.post({ type: "assistantStart" });
    this.post({ type: "running", running: true, stopping: false });
    this.postConfig();

    try {
      const result = await this.client!.prompt(promptBlocks);

      if (this.stopping || result.stopReason === "cancelled" || result.stopReason === "canceled") {
        this.finishCancel();
        return;
      }

      this.busy = false;
      this.post({ type: "assistantDone", stopReason: result.stopReason });
      this.post({ type: "running", running: false });
      this.setRunningContext(false);
      this.postConfig();
    } catch (err) {
      if (this.stopping) {
        this.finishCancel();
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      if (message === "cancelled") {
        this.finishCancel();
        return;
      }

      this.busy = false;
      this.post({ type: "error", text: message });
      this.post({ type: "assistantDone", stopReason: "error" });
      this.post({ type: "running", running: false });
      this.setRunningContext(false);
      this.postConfig();
    }
  }

  private setRunningContext(running: boolean): void {
    void vscode.commands.executeCommand("setContext", "cursorAgent.running", running);
  }

  private post(message: Record<string, unknown>): void {
    if (this.replayingSession) {
      this.replayBuffer.push(message);
      return;
    }
    void this.view?.webview.postMessage(message);
  }

  private flushReplayBuffer(): void {
    for (const message of this.replayBuffer) {
      void this.view?.webview.postMessage(message);
    }
    this.replayBuffer = [];
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
      <button id="usageBtn" class="top-btn" type="button" title="${this.uiText("Cursor 使用量ダッシュボードを開く", "Open the Cursor usage dashboard")}">${this.uiText("使用量", "Usage")}</button>
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
    <main id="thread" class="thread" aria-live="polite"></main>
    <div id="emptyState" class="empty-state">
      <div class="empty-title">Cursor Agent</div>
      <div class="empty-sub">${this.uiText("コードについて質問したり、編集やタスクを依頼できます", "Ask about your code, request edits, or assign tasks")}</div>
      <ul class="empty-hints">
        <li><kbd>@</kbd><span>${this.uiText("ファイル・フォルダをコンテキストに追加", "Add files and folders as context")}</span></li>
        <li><kbd>/</kbd><span>${this.uiText("コマンド・スキルを呼び出す", "Invoke commands and skills")}</span></li>
        <li><kbd>Shift</kbd><span class="kbd-plus">+</span><kbd>Enter</kbd><span>${this.uiText("改行を挿入", "Insert a new line")}</span></li>
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
    <span class="task-hint"><kbd>Esc</kbd> ${this.uiText("で停止", "to stop")}</span>
  </div>
  <footer class="composer-dock">
    <div id="modeMenu" class="picker-menu hidden" role="menu"></div>
    <div id="modelMenu" class="picker-menu picker-menu-wide hidden" role="menu"></div>
    <div id="suggestMenu" class="suggest-menu hidden" role="listbox"></div>
    <div class="composer-card">
      <div id="contextTray" class="context-tray hidden" aria-label="${this.uiText("添付コンテキスト", "Attached context")}"></div>
      <div id="attachmentTray" class="attachment-tray hidden" aria-label="${this.uiText("添付画像", "Attached images")}"></div>
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
          <button id="stopBtn" class="icon-btn stop-btn-round hidden" type="button" title="Stop (Esc)">
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
