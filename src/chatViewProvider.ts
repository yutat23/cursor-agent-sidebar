import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { AcpClient, AgentMode } from "./acpClient";
import { AcpSessionInfo, formatModelDisplayName, SessionPickerConfig } from "./sessionConfig";
import { searchFileItems, searchSlashItems } from "./contextCatalog";
import { buildPromptText } from "./promptBuilder";
import { FileEditCardData, parseToolUpdate } from "./toolCallParser";

type WebviewMessage =
  | { type: "send"; text: string }
  | { type: "requestSuggestions"; kind: "file" | "slash"; query: string }
  | { type: "newChat" }
  | { type: "cancel" }
  | { type: "setMode"; modeId: AgentMode }
  | { type: "setModel"; modelId: string }
  | { type: "permissionResponse"; id: string; decision: string }
  | { type: "openFile"; path: string; line?: number }
  | { type: "selectSession"; sessionId: string }
  | { type: "setAutoApprove"; enabled: boolean }
  | { type: "refreshSessions" }
  | { type: "ready" };

interface PermissionPresentation {
  headline: string;
  detail: string;
  icon: string;
}

const MODE_ICONS: Record<AgentMode, string> = {
  agent: "∞",
  plan: "☰",
  ask: "?",
};

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private client?: AcpClient;
  private busy = false;
  private stopping = false;
  private mode: AgentMode = "agent";
  private modelId = "default[]";
  private sessionConfig?: SessionPickerConfig;
  private permissionRequests = new Map<string, (decision: string) => void>();
  private permissionCounter = 0;
  private fileEdits = new Map<string, FileEditCardData>();
  private workspaceRoot = "";
  private replayAssistantOpen = false;
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
          await this.handleSend(msg.text);
          break;
        case "requestSuggestions":
          await this.handleRequestSuggestions(msg.kind, msg.query);
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
          this.resolvePermission(msg.id, msg.decision);
          break;
        case "openFile":
          await this.openFile(msg.path, msg.line);
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
    this.post({ type: "init", status: "loading", message: "エージェントに接続中..." });

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
      this.post({ type: "init", status: "error", message: `接続に失敗しました: ${message}` });
      this.post({ type: "error", text: `接続に失敗しました: ${message}` });
      this.abandonClient(client);
      throw err;
    }
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
        this.post({ type: "error", text: "このエージェントは履歴の読み込みに対応していません" });
        return;
      }

      this.replayAssistantOpen = false;
      this.fileEdits.clear();
      this.post({ type: "clear" });
      this.post({ type: "sessionLoading", title: "チャットを読み込み中..." });
      this.sessionConfig = await this.client.loadSession(sessionId);
      this.finishReplayTurn();
      this.mode = this.sessionConfig.currentModeId;
      this.modelId = this.sessionConfig.currentModelId;
      await this.savePreferences();
      this.postConfig();
      this.post({ type: "sessionLoaded" });
      await this.refreshSessions();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", text: `チャットの読み込みに失敗: ${message}` });
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
      this.post({ type: "error", text: `モード変更に失敗: ${message}` });
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
      this.post({ type: "error", text: `モデル変更に失敗: ${message}` });
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
      this.post({ type: "fileEdit", ...merged });
      return;
    }

    this.post({
      type: "toolActivity",
      id: parsed.toolCallId,
      title: parsed.activityTitle ?? parsed.title ?? "ツール",
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
      this.post({ type: "error", text: `ファイルを開けませんでした: ${message}` });
    }
  }

  private resolvePermission(id: string, decision: string): void {
    const resolve = this.permissionRequests.get(id);
    if (!resolve) {
      return;
    }
    this.permissionRequests.delete(id);
    resolve(decision);
  }

  private formatPermission(title: string, kind?: string): PermissionPresentation {
    const quoted = title.match(/"([^"]+)"/);
    const path = quoted?.[1] ?? title;
    const lower = `${kind ?? ""} ${title}`.toLowerCase();

    if (lower.includes("write") || lower.includes("edit") || lower.includes("create") || /\.(bat|sh|ps1|js|ts|py|md|json)/i.test(path)) {
      return { headline: "ファイルの作成・変更", detail: path, icon: "📝" };
    }
    if (lower.includes("run") || lower.includes("exec") || lower.includes("command") || lower.includes("shell")) {
      return { headline: "コマンドの実行", detail: path, icon: "⚡" };
    }
    if (lower.includes("read") || lower.includes("glob") || lower.includes("search")) {
      return { headline: "ファイルの読み取り", detail: path, icon: "🔍" };
    }

    return { headline: "ツールの実行", detail: path, icon: "🔧" };
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
      const content = update.content as { text?: string } | undefined;

      if (sessionUpdate === "user_message_chunk" && content?.text) {
        this.finishReplayTurn();
        this.post({ type: "userMessage", text: content.text });
        return;
      }

      if (sessionUpdate === "agent_message_chunk" && content?.text) {
        if (!this.busy && !this.replayAssistantOpen) {
          this.post({ type: "assistantStart" });
          this.replayAssistantOpen = true;
        }
        this.post({ type: "assistantChunk", text: content.text });
        return;
      }

      if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
        void this.handleToolUpdate(update);
        return;
      }

      if (sessionUpdate === "agent_thought_chunk" && content?.text) {
        this.post({ type: "thinking", text: content.text, append: true });
      }
    });

    client.on(
      "permission",
      ({ title, kind, resolve }: { title: string; kind?: string; resolve: (v: string) => void }) => {
        const id = String(++this.permissionCounter);
        this.permissionRequests.set(id, resolve);
        const presentation = this.formatPermission(title, kind);
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
          "プランを承認しますか？",
          { modal: true },
          "承認",
          "拒否"
        );

        resolve(choice === "承認" ? "accepted" : "rejected");
      }
    );

    client.on("cancelled", () => {
      if (this.stopping) {
        this.finishCancel();
      }
    });

    client.on("exit", (code) => {
      this.post({ type: "error", text: `エージェントプロセスが終了しました (code: ${code})` });
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
      this.post({ type: "error", text: `停止に失敗しました: ${message}` });
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
    this.busy = false;
    this.stopping = false;
    this.setRunningContext(false);
    this.replayAssistantOpen = false;
    this.post({ type: "clear" });
    this.post({ type: "init", status: "loading", message: "新しいチャットを準備中..." });

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
      this.post({ type: "init", status: "error", message: `新しいチャットの開始に失敗: ${message}` });
      this.post({ type: "error", text: `新しいチャットの開始に失敗: ${message}` });

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

  private async handleSend(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.busy) {
      return;
    }

    try {
      await this.ensureClient();
    } catch {
      return;
    }

    const root = this.workspaceRoot || process.cwd();
    const promptText = await buildPromptText(trimmed, root);

    this.busy = true;
    this.stopping = false;
    this.setRunningContext(true);
    this.post({ type: "userMessage", text: trimmed });
    this.post({ type: "assistantStart" });
    this.post({ type: "running", running: true, stopping: false });
    this.postConfig();

    try {
      const result = await this.client!.prompt(promptText);

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
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.js"));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Cursor Agent</title>
</head>
<body>
  <div class="top-bar">
    <button id="historyBtn" class="top-btn history-btn" type="button" title="チャット履歴" disabled>
      <svg class="btn-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5"/>
        <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span id="historyLabel">履歴</span>
      <span class="pill-chevron">▾</span>
    </button>
    <button id="newChat" class="top-btn new-chat-btn" type="button" title="新しいチャット">
      <svg class="btn-svg" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      <span>New Chat</span>
    </button>
  </div>
  <div id="historyMenu" class="picker-menu picker-menu-wide hidden" role="menu"></div>
  <div id="bootOverlay" class="boot-overlay">
    <div class="boot-card">
      <span class="boot-spinner"></span>
      <span id="bootLabel">エージェントに接続中...</span>
    </div>
  </div>
  <div class="thread-wrap">
    <main id="thread" class="thread" aria-live="polite"></main>
    <div id="emptyState" class="empty-state">
      <div class="empty-title">Cursor Agent</div>
      <div class="empty-sub">コードについて質問したり、編集やタスクを依頼できます</div>
      <ul class="empty-hints">
        <li><kbd>@</kbd><span>ファイル・フォルダをコンテキストに追加</span></li>
        <li><kbd>/</kbd><span>コマンド・スキルを呼び出す</span></li>
        <li><kbd>Shift</kbd><span class="kbd-plus">+</span><kbd>Enter</kbd><span>改行を挿入</span></li>
      </ul>
    </div>
    <button id="jumpBottom" class="jump-bottom hidden" type="button" title="最新のメッセージへ">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  </div>
  <div id="taskStatus" class="task-status hidden" role="status">
    <span class="task-label">
      <span class="task-spinner"></span>
      <span id="taskLabel">エージェント実行中...</span>
    </span>
    <span class="task-hint"><kbd>Esc</kbd> で停止</span>
  </div>
  <footer class="composer-dock">
    <div id="modeMenu" class="picker-menu hidden" role="menu"></div>
    <div id="modelMenu" class="picker-menu picker-menu-wide hidden" role="menu"></div>
    <div id="suggestMenu" class="suggest-menu hidden" role="listbox"></div>
    <div class="composer-card">
      <textarea id="input" rows="1" placeholder="質問や指示を入力（@ でコンテキスト追加）"></textarea>
      <div class="composer-footer">
        <div class="composer-meta">
          <button id="modePill" class="pill" type="button" title="モード">
            <span class="pill-icon">∞</span>
            <span class="pill-label">Agent</span>
            <span class="pill-chevron">▾</span>
          </button>
          <button id="modelPill" class="pill pill-model" type="button" title="モデル">
            <span class="pill-label">Auto</span>
            <span class="pill-chevron">▾</span>
          </button>
          <button
            id="autoRunPill"
            class="pill pill-autorun"
            type="button"
            title="自動実行 OFF — クリックで ON（--yolo 相当）"
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
          <button id="send" class="icon-btn send-btn" type="button" title="送信 (Enter)">
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
