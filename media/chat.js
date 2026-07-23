(function () {
  const vscode = acquireVsCodeApi();
  const locale = document.documentElement.lang.toLowerCase().startsWith("ja") ? "ja" : "en";
  const TEXT = {
    taskStopping: ["停止しています...", "Stopping..."],
    taskRunning: ["エージェント実行中...", "Agent is running..."],
    followupPlaceholder: ["フォローアップを入力...", "Enter a follow-up..."],
    promptPlaceholder: ["質問や指示を入力（@ でコンテキスト追加）", "Ask a question or enter an instruction (@ for context)"],
    autoRunOn: ["自動実行 ON — ツールは確認なしで実行されます（--yolo）", "Auto-run ON — tools run without confirmation (--yolo)"],
    autoRunOff: ["自動実行 OFF — クリックで ON（--yolo 相当）", "Auto-run OFF — click to enable (--yolo equivalent)"],
    connecting: ["エージェントに接続中...", "Connecting to the agent..."],
    connectionFailed: ["接続に失敗しました", "Connection failed"],
    diagnostics: ["診断", "Diagnostics"],
    justNow: ["たった今", "just now"],
    minutesAgo: ["{0}分前", "{0} min ago"],
    hoursAgo: ["{0}時間前", "{0} hr ago"],
    daysAgo: ["{0}日前", "{0} days ago"],
    history: ["履歴", "History"],
    loading: ["読み込み中...", "Loading..."],
    alwaysAllow: ["常に許可", "Always allow"],
    noSavedRules: ["保存済みルールはありません", "No saved rules"],
    remove: ["削除", "Remove"],
    clear: ["消去", "Clear"],
    noHistory: ["履歴はありません", "No history"],
    autoAllowed: ["自動許可", "Auto-allowed"],
    denied: ["拒否", "Denied"],
    allowed: ["許可", "Allowed"],
    tool: ["ツール", "Tool"],
    changeReview: ["変更レビュー", "Change review"],
    noChanges: ["まだ変更はありません", "No changes yet"],
    openDiff: ["差分を開く", "Open diff"],
    open: ["開く", "Open"],
    revert: ["戻す", "Revert"],
    cancelled: ["キャンセルされました", "Cancelled"],
    toolExecution: ["ツールの実行", "Tool execution"],
    allow: ["許可", "Allow"],
    allowAlways: ["常に許可", "Always allow"],
    reject: ["拒否", "Deny"],
    allowedOnce: ["許可しました", "Allowed"],
    allowedAlways: ["常に許可しました", "Always allowed"],
    rejected: ["拒否しました", "Denied"],
    copy: ["コピー", "Copy"],
    copyMessage: ["メッセージをコピー", "Copy message"],
    imageTooLarge: ["画像は 5MB 以下にしてください", "Images must be 5 MB or smaller"],
    maxImages: ["画像は最大 {0} 枚までです", "You can attach up to {0} images"],
    imageLoadFailed: ["画像の読み込みに失敗しました", "Failed to load image"],
    openImage: ["クリックして拡大表示", "Click to enlarge"],
    closeImage: ["閉じる", "Close"],
    openFile: ["クリックしてファイルを開く", "Click to open file"],
    historyLoadFailed: ["このセッションの表示用履歴を読み込めませんでした。エージェント側の状態は復元済みなので、続きからメッセージを送れます。", "The display history for this session could not be loaded. The agent state was restored, so you can continue sending messages."],
  };

  function t(key, ...values) {
    const entry = TEXT[key];
    const template = entry ? entry[locale === "ja" ? 0 : 1] : key;
    return template.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ""));
  }

  const threadEl = document.getElementById("thread");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const stopBtn = document.getElementById("stopBtn");
  const footerSpinner = document.getElementById("footerSpinner");
  const modePill = document.getElementById("modePill");
  const modelPill = document.getElementById("modelPill");
  const autoRunPill = document.getElementById("autoRunPill");
  const modeMenu = document.getElementById("modeMenu");
  const modelMenu = document.getElementById("modelMenu");
  const suggestMenu = document.getElementById("suggestMenu");
  const newChatBtn = document.getElementById("newChat");
  const usageBtn = document.getElementById("usageBtn");
  const changesBtn = document.getElementById("changesBtn");
  const changesMenu = document.getElementById("changesMenu");
  const permissionsBtn = document.getElementById("permissionsBtn");
  const permissionsMenu = document.getElementById("permissionsMenu");
  const historyBtn = document.getElementById("historyBtn");
  const historyMenu = document.getElementById("historyMenu");
  const historyLabel = document.getElementById("historyLabel");
  const bootOverlay = document.getElementById("bootOverlay");
  const bootLabel = document.getElementById("bootLabel");
  const bootActions = document.getElementById("bootActions");
  const retryConnectBtn = document.getElementById("retryConnectBtn");
  const diagnoseBtn = document.getElementById("diagnoseBtn");
  const openSettingsBtn = document.getElementById("openSettingsBtn");
  const diagnosticsPanel = document.getElementById("diagnosticsPanel");
  const taskStatus = document.getElementById("taskStatus");
  const taskLabel = document.getElementById("taskLabel");
  const emptyState = document.getElementById("emptyState");
  const jumpBottom = document.getElementById("jumpBottom");
  const contextTray = document.getElementById("contextTray");
  const attachmentTray = document.getElementById("attachmentTray");
  const imageLightbox = document.getElementById("imageLightbox");
  const imageLightboxImg = document.getElementById("imageLightboxImg");
  const imageLightboxClose = document.getElementById("imageLightboxClose");

  const MAX_IMAGE_ATTACHMENTS = 4;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

  let pendingAttachments = [];
  let attachmentIdCounter = 0;

  let busy = false;
  let stopping = false;
  let currentTurn = null;
  let currentAssistantEl = null;
  let currentToolPanel = null;
  let toolRows = new Map();
  let currentThinkingEl = null;
  let fileEditsPanel = null;
  let fileEditCards = new Map();
  let activityPanel = null;
  let responsePanel = null;
  let thinkingStart = 0;

  const MODE_ICONS = { agent: "∞", plan: "☰", ask: "?" };

  let sessionConfig = null;
  let sessionReady = false;
  let autoApproveEnabled = false;
  let sessions = [];
  let currentSessionId = null;
  let changeReviewItems = [];
  let permissionRules = [];
  let permissionHistory = [];
  let openMenu = null;
  let suggestState = null;
  let suggestTimer = null;
  let suggestRequestId = 0;
  let contextPreviewTimer = null;
  let contextPreviewText = "";
  let isComposing = false;

  function requestCancel() {
    if (!busy || stopping) return;
    vscode.postMessage({ type: "cancel" });
  }

  function setRunning(running, isStopping) {
    busy = running;
    stopping = !!isStopping;

    sendBtn.classList.toggle("hidden", running);
    stopBtn.classList.toggle("hidden", !running);
    footerSpinner.classList.toggle("hidden", !running || isStopping);
    taskStatus.classList.toggle("hidden", !running);

    taskLabel.textContent = isStopping ? t("taskStopping") : t("taskRunning");
    inputEl.disabled = running;
    inputEl.placeholder = running
      ? t("followupPlaceholder")
      : t("promptPlaceholder");

    updateInteractiveState();

    if (running) {
      inputEl.focus();
    }
  }

  function updateInteractiveState() {
    const blocked = !sessionReady || busy;
    modePill.disabled = blocked;
    modelPill.disabled = blocked;
    historyBtn.disabled = blocked;
    autoRunPill.disabled = !sessionReady;
    inputEl.disabled = blocked;
    sendBtn.disabled = blocked;
  }

  function applyAutoRun(enabled) {
    autoApproveEnabled = !!enabled;
    autoRunPill.classList.toggle("is-active", autoApproveEnabled);
    autoRunPill.setAttribute("aria-pressed", autoApproveEnabled ? "true" : "false");
    autoRunPill.title = autoApproveEnabled
      ? t("autoRunOn")
      : t("autoRunOff");
  }

  function setBootState(status, message) {
    if (status === "loading") {
      bootOverlay.classList.remove("hidden");
      bootLabel.textContent = message || t("connecting");
      bootActions.classList.add("hidden");
      diagnosticsPanel.classList.add("hidden");
      diagnosticsPanel.innerHTML = "";
      sessionReady = false;
      updateInteractiveState();
      return;
    }

    if (status === "error") {
      bootOverlay.classList.remove("hidden");
      bootLabel.textContent = message || t("connectionFailed");
      bootActions.classList.remove("hidden");
      sessionReady = false;
      updateInteractiveState();
      return;
    }

    if (status === "ready") {
      bootOverlay.classList.add("hidden");
      bootActions.classList.add("hidden");
      diagnosticsPanel.classList.add("hidden");
      diagnosticsPanel.innerHTML = "";
      sessionReady = true;
      updateInteractiveState();
    }
  }

  function renderDiagnostics(results, running) {
    diagnosticsPanel.innerHTML = "";
    diagnosticsPanel.classList.remove("hidden");
    diagnoseBtn.disabled = !!running;

    for (const result of results || []) {
      const row = document.createElement("div");
      row.className = `diagnostic-row${result.ok ? " is-ok" : " is-error"}`;
      row.innerHTML = `
        <div class="diagnostic-head">
          <span class="diagnostic-dot"></span>
          <span class="diagnostic-label">${escapeHtml(result.label || t("diagnostics"))}</span>
        </div>
        <pre class="diagnostic-output">${escapeHtml(result.output || "")}</pre>
      `;
      diagnosticsPanel.appendChild(row);
    }
  }

  function hasContextReference(text) {
    return /(^|\n)\/[\w-]+/.test(text.trim()) || /@([^\s@]+)/.test(text);
  }

  function formatChars(chars) {
    if (!chars) {
      return "0 chars";
    }
    if (chars >= 1000) {
      return `${(chars / 1000).toFixed(chars >= 10000 ? 0 : 1)}k chars`;
    }
    return `${chars} chars`;
  }

  function queueContextPreview() {
    clearTimeout(contextPreviewTimer);
    const text = inputEl.value;
    contextPreviewText = text;

    if (!sessionReady || busy || !hasContextReference(text)) {
      renderContextPreview([]);
      return;
    }

    contextPreviewTimer = setTimeout(() => {
      vscode.postMessage({ type: "requestContextPreview", text });
    }, 180);
  }

  function removeContextReference(item) {
    if (!item?.replaceText) {
      return;
    }
    const escaped = item.replaceText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    inputEl.value = inputEl.value.replace(new RegExp(`${escaped}\\s?`, "g"), "");
    inputEl.focus();
    inputEl.dispatchEvent(new Event("input"));
  }

  function renderContextPreview(items, error) {
    if (!contextTray) {
      return;
    }

    contextTray.innerHTML = "";
    if (error) {
      contextTray.classList.remove("hidden");
      const errorEl = document.createElement("div");
      errorEl.className = "context-error";
      errorEl.textContent = error;
      contextTray.appendChild(errorEl);
      return;
    }

    if (!items?.length) {
      contextTray.classList.add("hidden");
      return;
    }

    contextTray.classList.remove("hidden");
    for (const item of items) {
      const chip = document.createElement("div");
      chip.className = `context-chip${item.status === "missing" ? " is-missing" : ""}`;
      const kindLabel =
        item.kind === "folder" ? "Folder" : item.kind === "command" ? "Prompt" : item.kind === "missing" ? "Missing" : "File";
      chip.innerHTML = `
        <span class="context-kind">${kindLabel}</span>
        <span class="context-body">
          <span class="context-label" title="${escapeHtml(item.label || "")}">${escapeHtml(item.label || "")}</span>
          <span class="context-detail">${escapeHtml(item.detail || "")} · ${formatChars(item.chars || 0)}</span>
        </span>
        <button class="context-remove" type="button" aria-label="Remove context">×</button>
      `;
      chip.querySelector(".context-remove").addEventListener("click", () => removeContextReference(item));
      contextTray.appendChild(chip);
    }
  }

  function closeMenus() {
    modeMenu.classList.add("hidden");
    modelMenu.classList.add("hidden");
    historyMenu.classList.add("hidden");
    changesMenu.classList.add("hidden");
    permissionsMenu.classList.add("hidden");
    openMenu = null;
  }

  function closeSuggestMenu() {
    suggestMenu.classList.add("hidden");
    suggestMenu.innerHTML = "";
    suggestState = null;
  }

  function getCaretToken() {
    const text = inputEl.value;
    const caret = inputEl.selectionStart ?? text.length;
    const before = text.slice(0, caret);

    const atMatch = before.match(/@([^\s@]*)$/);
    if (atMatch) {
      return {
        kind: "file",
        query: atMatch[1],
        replaceStart: caret - atMatch[0].length,
        replaceEnd: caret,
        prefix: "@",
      };
    }

    const slashMatch = before.match(/(?:^|\n)\/([\w-]*)$/);
    if (slashMatch) {
      return {
        kind: "slash",
        query: slashMatch[1],
        replaceStart: caret - slashMatch[1].length - 1,
        replaceEnd: caret,
        prefix: "/",
      };
    }

    return null;
  }

  function positionSuggestMenu() {
    const rect = inputEl.getBoundingClientRect();
    const left = Math.max(8, rect.left);
    const bottom = window.innerHeight - rect.top + 8;
    suggestMenu.style.left = `${left}px`;
    suggestMenu.style.bottom = `${bottom}px`;
    // 入力欄の幅に揃える（画面からはみ出さない範囲で）
    suggestMenu.style.width = `${Math.max(240, Math.min(rect.width, window.innerWidth - left - 8))}px`;
  }

  const SUGGEST_ICONS = {
    file:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>",
    folder:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M1.75 3.5c0-.41.34-.75.75-.75h3.4l1.6 1.75h5.75c.41 0 .75.34.75.75v7c0 .41-.34.75-.75.75h-10.75a.75.75 0 0 1-.75-.75z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
      "</svg>",
    command:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M10 2.5 6 13.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      "</svg>",
    skill:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
      '<path d="M8 1.5 9.6 5.6 13.7 7.2 9.6 8.8 8 12.9 6.4 8.8 2.3 7.2 6.4 5.6z"/>' +
      "</svg>",
  };

  // "Core/TcpClient.cs" → 名前とディレクトリに分ける（Codex 風の1行表示用）
  function splitSuggestLabel(item) {
    if (item.kind === "file" || item.kind === "folder") {
      const trimmed = item.label.replace(/\/$/, "");
      const idx = trimmed.lastIndexOf("/");
      const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
      return {
        name: item.kind === "folder" ? `${name}/` : name,
        sub: idx >= 0 ? trimmed.slice(0, idx) : "",
      };
    }
    return { name: item.label, sub: item.detail || "" };
  }

  function renderSuggestMenu() {
    if (!suggestState?.items?.length) {
      closeSuggestMenu();
      return;
    }

    suggestMenu.innerHTML = "";
    suggestState.items.forEach((item, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "suggest-item" +
        (suggestState.kind === "file" ? " is-file-suggest" : " is-slash-suggest") +
        (index === suggestState.activeIndex ? " is-active" : "");
      btn.dataset.index = String(index);
      const { name, sub } = splitSuggestLabel(item);
      btn.innerHTML = `
        <span class="suggest-icon">${SUGGEST_ICONS[item.kind] || SUGGEST_ICONS.file}</span>
        <span class="suggest-name">${escapeHtml(name)}</span>
        ${sub ? `<span class="suggest-path">${escapeHtml(sub)}</span>` : ""}
      `;
      btn.title = item.detail ? `${item.label} — ${item.detail}` : item.label;
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        applySuggestion(index);
      });
      suggestMenu.appendChild(btn);
    });

    suggestMenu.classList.remove("hidden");
    positionSuggestMenu();

    const activeBtn = suggestMenu.querySelector(".suggest-item.is-active");
    activeBtn?.scrollIntoView({ block: "nearest" });
  }

  function applySuggestion(index) {
    if (!suggestState) return;
    const item = suggestState.items[index];
    if (!item) return;

    const text = inputEl.value;
    const insertValue =
      suggestState.prefix === "@"
        ? `${suggestState.prefix}${item.insertText} `
        : `${suggestState.prefix}${item.insertText} `;

    inputEl.value =
      text.slice(0, suggestState.replaceStart) + insertValue + text.slice(suggestState.replaceEnd);

    const caret = suggestState.replaceStart + insertValue.length;
    inputEl.setSelectionRange(caret, caret);
    inputEl.focus();
    closeSuggestMenu();
    inputEl.dispatchEvent(new Event("input"));
  }

  function isSameSuggestToken(token) {
    return (
      suggestState &&
      suggestState.kind === token.kind &&
      suggestState.query === token.query
    );
  }

  function queueSuggestions(token) {
    if (!sessionReady || busy) {
      closeSuggestMenu();
      return;
    }

    const keepSelection = isSameSuggestToken(token);
    clearTimeout(suggestTimer);
    const requestId = ++suggestRequestId;

    suggestState = {
      kind: token.kind,
      query: token.query,
      replaceStart: token.replaceStart,
      replaceEnd: token.replaceEnd,
      prefix: token.prefix,
      items: keepSelection ? suggestState.items : [],
      activeIndex: keepSelection ? suggestState.activeIndex : 0,
      requestId,
    };

    suggestTimer = setTimeout(() => {
      vscode.postMessage({
        type: "requestSuggestions",
        kind: token.kind,
        query: token.query,
      });
    }, 120);
  }

  function updateSuggestFromInput() {
    const token = getCaretToken();
    if (!token) {
      closeSuggestMenu();
      return;
    }

    if (isSameSuggestToken(token) && suggestState.items.length > 0) {
      suggestState.replaceStart = token.replaceStart;
      suggestState.replaceEnd = token.replaceEnd;
      return;
    }

    queueSuggestions(token);
  }

  function isSuggestNavigationKey(key) {
    return [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Tab",
      "Enter",
      "Escape",
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ].includes(key);
  }

  function positionMenu(menu, anchor, placement) {
    const rect = anchor.getBoundingClientRect();
    const menuWidth = menu.classList.contains("picker-menu-wide") ? 260 : 200;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
    const openBelow =
      placement === "below" ||
      (placement !== "above" && rect.top < window.innerHeight * 0.45);

    menu.style.left = `${left}px`;
    menu.style.right = "auto";

    if (openBelow) {
      menu.style.top = `${rect.bottom + 6}px`;
      menu.style.bottom = "auto";
    } else {
      menu.style.top = "auto";
      menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    }
  }

  function applyConfig(config) {
    sessionConfig = config;
    modePill.querySelector(".pill-icon").textContent = config.currentModeIcon || MODE_ICONS[config.currentModeId] || "∞";
    modePill.querySelector(".pill-label").textContent = config.currentModeLabel || config.currentModeId;
    modelPill.querySelector(".pill-label").textContent = config.currentModelLabel || "Auto";
    modelPill.title = config.currentModelLabel || "Model";
    if (typeof config.autoApprovePermissions === "boolean") {
      applyAutoRun(config.autoApprovePermissions);
    }
    if (openMenu === "model") {
      const search = modelMenu.querySelector(".picker-search");
      const filter = search ? search.value : "";
      renderModelMenu(filter);
      if (search) {
        const nextSearch = modelMenu.querySelector(".picker-search");
        if (nextSearch) {
          nextSearch.value = filter;
          nextSearch.focus();
          nextSearch.setSelectionRange(filter.length, filter.length);
        }
      }
    }
  }

  function formatRelativeTime(iso) {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return t("justNow");
    if (mins < 60) return t("minutesAgo", mins);
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t("hoursAgo", hours);
    const days = Math.floor(hours / 24);
    if (days < 7) return t("daysAgo", days);
    return date.toLocaleDateString("ja-JP", { month: "short", day: "numeric" });
  }

  function renderHistoryMenu() {
    historyMenu.innerHTML = "";
    const list = document.createElement("div");
    list.className = "picker-list";

    if (!sessions.length) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = sessionReady ? t("noHistory") : t("loading");
      list.appendChild(empty);
    } else {
      for (const session of sessions) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "picker-item picker-session" +
          (session.sessionId === currentSessionId ? " is-selected" : "");
        const title = escapeHtml(session.title || "Untitled");
        btn.innerHTML = `
          <span class="picker-item-body">
            <span class="picker-item-title">${title}</span>
            <span class="picker-item-desc">${formatRelativeTime(session.updatedAt)}</span>
          </span>
          ${session.sessionId === currentSessionId ? '<span class="picker-check">✓</span>' : ""}
        `;
        btn.addEventListener("click", () => {
          closeMenus();
          if (session.sessionId !== currentSessionId) {
            vscode.postMessage({ type: "selectSession", sessionId: session.sessionId });
          }
        });
        list.appendChild(btn);
      }
    }

    historyMenu.appendChild(list);
  }

  function formatPermissionTime(iso) {
    if (!iso) {
      return "";
    }
    return formatRelativeTime(iso);
  }

  function renderPermissionMenu() {
    permissionsMenu.innerHTML = "";

    const rulesTitle = document.createElement("div");
    rulesTitle.className = "permission-menu-title";
    rulesTitle.textContent = t("alwaysAllow");
    permissionsMenu.appendChild(rulesTitle);

    const rulesList = document.createElement("div");
    rulesList.className = "picker-list permission-list";
    if (!permissionRules.length) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = t("noSavedRules");
      rulesList.appendChild(empty);
    } else {
      for (const rule of permissionRules) {
        const row = document.createElement("div");
        row.className = "permission-menu-row";
        row.innerHTML = `
          <span class="permission-menu-copy">
            <span class="permission-menu-head">${escapeHtml(rule.headline || t("tool"))}</span>
            <span class="permission-menu-detail">${escapeHtml(rule.detail || "")}</span>
          </span>
          <button class="permission-menu-remove" type="button" title="${t("remove")}">×</button>
        `;
        row.querySelector(".permission-menu-remove").addEventListener("click", () => {
          vscode.postMessage({ type: "removePermissionRule", id: rule.id });
        });
        rulesList.appendChild(row);
      }
    }
    permissionsMenu.appendChild(rulesList);

    const historyTitle = document.createElement("div");
    historyTitle.className = "permission-menu-title permission-menu-title-inline";
    historyTitle.innerHTML = `<span>${t("history")}</span><button class="permission-clear" type="button">${t("clear")}</button>`;
    historyTitle.querySelector(".permission-clear").addEventListener("click", () => {
      vscode.postMessage({ type: "clearPermissionHistory" });
    });
    permissionsMenu.appendChild(historyTitle);

    const historyList = document.createElement("div");
    historyList.className = "picker-list permission-list";
    if (!permissionHistory.length) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = t("noHistory");
      historyList.appendChild(empty);
    } else {
      for (const item of permissionHistory.slice(0, 12)) {
        const row = document.createElement("div");
        row.className = "permission-history-row";
        const decision =
          item.autoApproved ? t("autoAllowed") :
          item.decision === "reject-once" ? t("denied") :
          item.decision === "allow-always" ? t("alwaysAllow") : t("allowed");
        row.innerHTML = `
          <span class="permission-menu-copy">
            <span class="permission-menu-head">${escapeHtml(decision)} · ${escapeHtml(item.headline || t("tool"))}</span>
            <span class="permission-menu-detail">${escapeHtml(item.detail || "")}</span>
          </span>
          <span class="permission-menu-time">${escapeHtml(formatPermissionTime(item.createdAt))}</span>
        `;
        historyList.appendChild(row);
      }
    }
    permissionsMenu.appendChild(historyList);
  }

  function renderChangesMenu() {
    changesMenu.innerHTML = "";

    const title = document.createElement("div");
    title.className = "permission-menu-title permission-menu-title-inline";
    title.innerHTML = `<span>${t("changeReview")}</span><button class="permission-clear" type="button">${t("clear")}</button>`;
    title.querySelector(".permission-clear").addEventListener("click", () => {
      vscode.postMessage({ type: "clearChangeReview" });
    });
    changesMenu.appendChild(title);

    const list = document.createElement("div");
    list.className = "picker-list changes-list";
    if (!changeReviewItems.length) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = t("noChanges");
      list.appendChild(empty);
    } else {
      for (const item of changeReviewItems) {
        const row = document.createElement("div");
        row.className = "change-review-row";
        row.innerHTML = `
          <button class="change-review-main" type="button" title="${t("openDiff")}">
            <span class="change-review-name">${escapeHtml(item.fileName || item.path)}</span>
            <span class="change-review-detail">${formatEditStats(item.addedLines || 0, item.removedLines || 0)} · ${escapeHtml(item.status || "updated")}</span>
          </button>
          <span class="change-review-actions">
            <button class="change-review-action" type="button" data-action="open">${t("open")}</button>
            <button class="change-review-action" type="button" data-action="revert" ${item.canRevert ? "" : "disabled"}>${t("revert")}</button>
          </span>
        `;
        row.querySelector(".change-review-main").addEventListener("click", () => {
          vscode.postMessage({ type: "openDiff", path: item.path });
        });
        row.querySelector('[data-action="open"]').addEventListener("click", () => {
          vscode.postMessage({ type: "openFile", path: item.path });
        });
        row.querySelector('[data-action="revert"]').addEventListener("click", () => {
          vscode.postMessage({ type: "revertFile", path: item.path });
        });
        list.appendChild(row);
      }
    }
    changesMenu.appendChild(list);
  }

  function renderModeMenu() {
    if (!sessionConfig?.modes?.length) {
      modeMenu.innerHTML = `<div class="picker-empty">${t("loading")}</div>`;
      return;
    }
    modeMenu.innerHTML = "";
    for (const mode of sessionConfig.modes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "picker-item" + (mode.id === sessionConfig.currentModeId ? " is-selected" : "");
      btn.innerHTML = `
        <span class="picker-item-icon">${MODE_ICONS[mode.id] || "•"}</span>
        <span class="picker-item-body">
          <span class="picker-item-title">${mode.name}</span>
          ${mode.description ? `<span class="picker-item-desc">${mode.description}</span>` : ""}
        </span>
        ${mode.id === sessionConfig.currentModeId ? '<span class="picker-check">✓</span>' : ""}
      `;
      btn.addEventListener("click", () => {
        closeMenus();
        if (mode.id !== sessionConfig.currentModeId) {
          vscode.postMessage({ type: "setMode", modeId: mode.id });
        }
      });
      modeMenu.appendChild(btn);
    }
  }

  function updateModelMenuList(filter) {
    if (!sessionConfig?.models?.length) {
      modelMenu.innerHTML = `<div class="picker-empty">${t("loading")}</div>`;
      return;
    }

    const query = (filter || "").trim().toLowerCase();
    let list = modelMenu.querySelector(".picker-list");
    if (!list) {
      list = document.createElement("div");
      list.className = "picker-list";
      modelMenu.appendChild(list);
    }

    list.innerHTML = "";

    const models = sessionConfig.models.filter((m) => {
      if (!query) {
        return true;
      }
      return m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query);
    });

    for (const model of models) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "picker-item" + (model.id === sessionConfig.currentModelId ? " is-selected" : "");
      btn.innerHTML = `
        <span class="picker-item-body">
          <span class="picker-item-title">${escapeHtml(model.name)}</span>
        </span>
        ${model.id === sessionConfig.currentModelId ? '<span class="picker-check">✓</span>' : ""}
      `;
      btn.addEventListener("click", () => {
        if (model.id !== sessionConfig.currentModelId) {
          vscode.postMessage({ type: "setModel", modelId: model.id });
        }
      });
      list.appendChild(btn);
    }

    if (models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = "No models found";
      list.appendChild(empty);
    }
  }

  function renderModelParameters() {
    const existing = modelMenu.querySelector(".model-params");
    if (existing) {
      existing.remove();
    }

    const params = sessionConfig?.modelParameters || [];
    if (!params.length || sessionConfig.currentModelId === "default") {
      return;
    }

    const section = document.createElement("div");
    section.className = "model-params";

    const header = document.createElement("div");
    header.className = "model-params-header";
    header.textContent = "Parameters";
    section.appendChild(header);

    for (const param of params) {
      const row = document.createElement("div");
      row.className = "model-param-row";

      const label = document.createElement("div");
      label.className = "model-param-label";
      label.textContent = param.name || param.id;
      row.appendChild(label);

      const chips = document.createElement("div");
      chips.className = "model-param-chips";

      for (const option of param.options || []) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className =
          "model-param-chip" + (option.value === param.currentValue ? " is-selected" : "");
        chip.textContent = option.name || option.value;
        chip.title = param.description || `${param.name}: ${option.name || option.value}`;
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          if (option.value !== param.currentValue) {
            vscode.postMessage({
              type: "setModelParameter",
              configId: param.id,
              value: option.value,
            });
          }
        });
        chips.appendChild(chip);
      }

      row.appendChild(chips);
      section.appendChild(row);
    }

    const search = modelMenu.querySelector(".picker-search");
    if (search && search.nextSibling) {
      modelMenu.insertBefore(section, search.nextSibling);
    } else if (search) {
      modelMenu.appendChild(section);
    } else {
      modelMenu.insertBefore(section, modelMenu.firstChild);
    }
  }

  function renderModelMenu(filter) {
    modelMenu.innerHTML = "";

    if (!sessionConfig?.models?.length) {
      modelMenu.innerHTML = `<div class="picker-empty">${t("loading")}</div>`;
      return;
    }

    const search = document.createElement("input");
    search.type = "text";
    search.className = "picker-search";
    search.placeholder = "Search models";
    search.value = filter || "";
    search.addEventListener("input", () => updateModelMenuList(search.value));
    search.addEventListener("keydown", (e) => e.stopPropagation());
    modelMenu.appendChild(search);

    renderModelParameters();
    updateModelMenuList(filter || "");
  }

  function toggleMenu(menuName) {
    if (!sessionReady || busy) return;
    if (openMenu === menuName) {
      closeMenus();
      return;
    }
    closeMenus();
    openMenu = menuName;
    if (menuName === "mode") {
      renderModeMenu();
      modeMenu.classList.remove("hidden");
      positionMenu(modeMenu, modePill);
    } else if (menuName === "model") {
      renderModelMenu("");
      modelMenu.classList.remove("hidden");
      positionMenu(modelMenu, modelPill);
      const search = modelMenu.querySelector(".picker-search");
      if (search) search.focus();
    } else if (menuName === "history") {
      vscode.postMessage({ type: "refreshSessions" });
      renderHistoryMenu();
      historyMenu.classList.remove("hidden");
      positionMenu(historyMenu, historyBtn, "below");
    } else if (menuName === "changes") {
      vscode.postMessage({ type: "requestChangeReview" });
      renderChangesMenu();
      changesMenu.classList.remove("hidden");
      positionMenu(changesMenu, changesBtn, "below");
    } else if (menuName === "permissions") {
      vscode.postMessage({ type: "requestPermissionState" });
      renderPermissionMenu();
      permissionsMenu.classList.remove("hidden");
      positionMenu(permissionsMenu, permissionsBtn, "below");
    }
  }

  // ── スクロール制御: 最下部付近にいるときだけ自動追従する ──
  let stickToBottom = true;

  function isNearBottom() {
    return threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 60;
  }

  function scrollToBottom(force) {
    if (!force && !stickToBottom) return;
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  threadEl.addEventListener("scroll", () => {
    stickToBottom = isNearBottom();
    jumpBottom.classList.toggle("hidden", stickToBottom);
  });

  jumpBottom.addEventListener("click", () => {
    stickToBottom = true;
    threadEl.scrollTo({ top: threadEl.scrollHeight, behavior: "smooth" });
    jumpBottom.classList.add("hidden");
  });

  // ── 空状態: スレッドに内容が現れたら非表示にする ──
  function updateEmptyState() {
    emptyState.classList.toggle("hidden", threadEl.childElementCount > 0);
  }

  new MutationObserver(updateEmptyState).observe(threadEl, { childList: true });
  updateEmptyState();

  function dismissPermissionCards() {
    document.querySelectorAll(".permission-card.pending").forEach((card) => {
      card.classList.remove("pending");
      card.classList.add("dismissed");
      const actions = card.querySelector(".permission-actions");
      if (actions) {
        actions.innerHTML = `<span class="permission-resolved">${t("cancelled")}</span>`;
      }
    });
  }

  function showPermissionCard(msg) {
    const card = document.createElement("div");
    card.className = "permission-card pending";
    card.dataset.requestId = msg.id;

    const icon = msg.icon || "🔧";
    const title = escapeHtml(msg.title || t("toolExecution"));
    const detail = escapeHtml(msg.detail || "");

    card.innerHTML = `
      <div class="permission-header">
        <span class="permission-icon">${icon}</span>
        <div class="permission-copy">
          <div class="permission-title">${title}</div>
          <div class="permission-detail" title="${detail}">${detail}</div>
        </div>
      </div>
      <div class="permission-actions">
        <button type="button" class="perm-btn perm-allow" data-decision="allow-once">${t("allow")}</button>
        <button type="button" class="perm-btn perm-always" data-decision="allow-always">${t("allowAlways")}</button>
        <button type="button" class="perm-btn perm-deny" data-decision="reject-once">${t("reject")}</button>
      </div>
    `;

    card.querySelectorAll(".perm-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const decision = btn.dataset.decision;
        const label =
          decision === "allow-once" ? t("allowedOnce") :
          decision === "allow-always" ? t("allowedAlways") : t("rejected");

        vscode.postMessage({ type: "permissionResponse", id: msg.id, decision });
        card.classList.remove("pending");
        card.classList.add("resolved");
        card.querySelector(".permission-actions").innerHTML =
          `<span class="permission-resolved">${label}</span>`;
      });
    });

    ensureActivityPanel().appendChild(card);
    scrollToBottom();
  }

  function formatThoughtDuration(ms) {
    const sec = Math.max(1, Math.round(ms / 1000));
    return `Thought for ${sec}s`;
  }

  function ensureTurn(role) {
    const turn = document.createElement("div");
    turn.className = `turn turn-${role}`;
    threadEl.appendChild(turn);
    currentTurn = turn;
    return turn;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const COPY_ICON =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.4"/>' +
    '<path d="M10.5 5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v5.4a1.3 1.3 0 0 0 1.3 1.3H5" stroke="currentColor" stroke-width="1.4"/>' +
    "</svg>";
  const CHECK_ICON =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";

  function copyToClipboard(text, btn) {
    const done = () => {
      btn.classList.add("copied");
      btn.innerHTML = CHECK_ICON;
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.innerHTML = COPY_ICON;
      }, 1200);
    };
    navigator.clipboard.writeText(text).then(done, () => {
      // clipboard API が使えない環境向けのフォールバック
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    });
  }

  // コードブロック・メッセージのコピーボタン（イベント委譲）
  threadEl.addEventListener("click", (e) => {
    const codeCopy = e.target.closest(".code-copy");
    if (codeCopy) {
      e.stopPropagation();
      const code = codeCopy.closest(".code-wrap")?.querySelector("code");
      copyToClipboard(code?.textContent ?? "", codeCopy);
      return;
    }
    const msgCopy = e.target.closest(".msg-copy");
    if (msgCopy) {
      e.stopPropagation();
      const msgEl = msgCopy.closest(".assistant-text");
      copyToClipboard(msgEl?.__raw ?? msgEl?.textContent ?? "", msgCopy);
    }
  });

  function renderInlineMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a class="md-link" href="$2">$1</a>');
    return html;
  }

  function normalizeCodeLanguage(raw) {
    const lang = (raw || "").trim().toLowerCase();
    const aliases = {
      javascript: "js",
      typescript: "ts",
      jsx: "jsx",
      tsx: "tsx",
      jsonc: "json",
      shell: "sh",
      bash: "sh",
      zsh: "sh",
      markdown: "md",
    };
    return aliases[lang] || lang;
  }

  function highlightCode(code, rawLanguage) {
    const language = normalizeCodeLanguage(rawLanguage);
    const placeholders = [];
    let html = escapeHtml(code);

    function placeholderKey(index) {
      let value = "";
      let current = index;
      do {
        value = String.fromCharCode(65 + (current % 26)) + value;
        current = Math.floor(current / 26) - 1;
      } while (current >= 0);
      return `@@HL_${value}@@`;
    }

    function stash(className, value) {
      const token = placeholderKey(placeholders.length);
      placeholders.push(`<span class="${className}">${value}</span>`);
      return token;
    }

    html = html.replace(/(&quot;(?:\\.|[^&])*?&quot;|'(?:\\.|[^'])*?'|`(?:\\.|[^`])*?`)/g, (match) =>
      stash("tok-string", match)
    );

    if (["js", "jsx", "ts", "tsx", "css", "scss"].includes(language)) {
      html = html.replace(/(\/\*[\s\S]*?\*\/)/g, (match) => stash("tok-comment", match));
    }
    if (["js", "jsx", "ts", "tsx"].includes(language)) {
      html = html.replace(/(\/\/[^\n]*)/g, (match) => stash("tok-comment", match));
    }
    if (["sh", "bash"].includes(language)) {
      html = html.replace(/(#[^\n]*)/g, (match) => stash("tok-comment", match));
    }

    if (["js", "jsx", "ts", "tsx"].includes(language)) {
      html = html.replace(
        /\b(import|export|from|const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|extends|new|async|await|try|catch|finally|throw|type|interface|enum|implements|public|private|protected|readonly|static|of|in|as)\b/g,
        '<span class="tok-keyword">$1</span>'
      );
      html = html.replace(/\b(true|false|null|undefined|this|super)\b/g, '<span class="tok-literal">$1</span>');
    } else if (language === "json") {
      html = html.replace(/(&quot;[^&]+&quot;)(\s*:)/g, '<span class="tok-property">$1</span>$2');
      html = html.replace(/\b(true|false|null)\b/g, '<span class="tok-literal">$1</span>');
    } else if (["css", "scss"].includes(language)) {
      html = html.replace(/([.#]?[a-zA-Z_-][\w-]*)(\s*\{)/g, '<span class="tok-selector">$1</span>$2');
      html = html.replace(/([a-zA-Z-]+)(\s*:)/g, '<span class="tok-property">$1</span>$2');
    } else if (["sh", "bash"].includes(language)) {
      html = html.replace(/\b(if|then|else|fi|for|do|done|case|esac|while|function|export|local|return|set)\b/g, '<span class="tok-keyword">$1</span>');
    } else if (language === "mermaid") {
      html = html.replace(
        /\b(sequenceDiagram|flowchart|graph|participant|actor|as|note|over|right|left|of|loop|alt|else|opt|par|and|end|classDiagram|stateDiagram|erDiagram|gantt|pie|journey)\b/g,
        '<span class="tok-keyword">$1</span>'
      );
      html = html.replace(/(--&gt;|--&gt;&gt;|-&gt;&gt;|--|---|==&gt;|-\.-&gt;)/g, '<span class="tok-operator">$1</span>');
    }

    html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>');

    placeholders.forEach((value, index) => {
      html = html.replace(placeholderKey(index), value);
    });

    return html;
  }

  function isTableSeparator(line) {
    return /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
  }

  function parseTableRow(line) {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function isBlockStart(lines, index) {
    const line = lines[index];
    if (!line?.trim()) {
      return false;
    }
    if (line.trim().startsWith("```")) {
      return true;
    }
    if (/^#{1,6}\s+/.test(line)) {
      return true;
    }
    if (/^(\-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      return true;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      return true;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      return true;
    }
    if (/^\s*>\s?/.test(line)) {
      return true;
    }
    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      return true;
    }
    return false;
  }

  function renderMarkdown(text) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (line.trim().startsWith("```")) {
        const fence = line.trim().match(/^```(\S*)/);
        const language = normalizeCodeLanguage(fence?.[1] || "");
        const chunks = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith("```")) {
          chunks.push(lines[i]);
          i += 1;
        }
        const langAttr = language ? ` data-lang="${escapeHtml(language)}"` : "";
        out.push(
          `<div class="code-wrap"><pre class="code-block"${langAttr}><code>${highlightCode(chunks.join("\n"), language)}</code></pre>` +
            `<button class="copy-btn code-copy" type="button" title="${t("copy")}">${COPY_ICON}</button></div>`
        );
        i += 1;
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const headerCells = parseTableRow(line);
        i += 2;
        const bodyRows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() && !isTableSeparator(lines[i])) {
          bodyRows.push(parseTableRow(lines[i]));
          i += 1;
        }

        let table = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
        for (const cell of headerCells) {
          table += `<th>${renderInlineMarkdown(cell)}</th>`;
        }
        table += "</tr></thead><tbody>";
        for (const row of bodyRows) {
          table += "<tr>";
          for (let c = 0; c < headerCells.length; c += 1) {
            table += `<td>${renderInlineMarkdown(row[c] || "")}</td>`;
          }
          table += "</tr>";
        }
        table += "</tbody></table></div>";
        out.push(table);
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        out.push(
          `<h${level} class="md-heading md-h${level}">${renderInlineMarkdown(headingMatch[2])}</h${level}>`
        );
        i += 1;
        continue;
      }

      if (/^(\-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
        out.push('<hr class="md-hr">');
        i += 1;
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
          i += 1;
        }
        out.push(
          `<ul class="md-list">${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`
        );
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
          i += 1;
        }
        out.push(
          `<ol class="md-list">${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ol>`
        );
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        out.push(`<blockquote class="md-quote">${renderInlineMarkdown(items.join(" "))}</blockquote>`);
        continue;
      }

      if (!line.trim()) {
        i += 1;
        continue;
      }

      const paraLines = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) {
        paraLines.push(lines[i]);
        i += 1;
      }
      if (paraLines.length) {
        out.push(`<p class="md-paragraph">${renderInlineMarkdown(paraLines.join(" "))}</p>`);
      }
    }

    return out.join("");
  }

  function renderAssistantContent(el) {
    const text = el.__raw ?? el.textContent ?? "";
    if (!text.trim()) {
      return;
    }

    el.__raw = text;
    el.innerHTML = renderMarkdown(text);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-btn msg-copy";
    copyBtn.title = t("copyMessage");
    copyBtn.innerHTML = COPY_ICON;
    el.appendChild(copyBtn);

    el.classList.add("rendered");
  }

  function openImageLightbox(src, alt) {
    if (!imageLightbox || !imageLightboxImg || !src) {
      return;
    }
    imageLightboxImg.src = src;
    imageLightboxImg.alt = alt || "Attached image";
    imageLightbox.classList.remove("hidden");
    imageLightbox.setAttribute("aria-hidden", "false");
    imageLightboxClose?.focus();
  }

  function closeImageLightbox() {
    if (!imageLightbox || imageLightbox.classList.contains("hidden")) {
      return;
    }
    imageLightbox.classList.add("hidden");
    imageLightbox.setAttribute("aria-hidden", "true");
    if (imageLightboxImg) {
      imageLightboxImg.removeAttribute("src");
      imageLightboxImg.alt = "";
    }
  }

  function isImageLightboxOpen() {
    return Boolean(imageLightbox && !imageLightbox.classList.contains("hidden"));
  }

  function bindImagePreview(img, src, alt) {
    img.classList.add("is-zoomable");
    img.title = t("openImage");
    img.setAttribute("role", "button");
    img.tabIndex = 0;
    const open = () => openImageLightbox(src || img.src, alt || img.alt);
    img.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      open();
    });
    img.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  }

  function appendUserMessage(text, images) {
    const turn = ensureTurn("user");
    const label = document.createElement("div");
    label.className = "turn-label";
    label.textContent = "You";

    const body = document.createElement("div");
    body.className = "user-message-body";

    if (text) {
      const el = document.createElement("div");
      el.className = "user-text";
      el.textContent = text;
      body.appendChild(el);
    }

    if (images?.length) {
      const gallery = document.createElement("div");
      gallery.className = "user-images";
      for (const image of images) {
        const img = document.createElement("img");
        img.className = "user-image";
        const src = `data:${image.mimeType};base64,${image.data}`;
        img.src = src;
        img.alt = "Attached image";
        bindImagePreview(img, src, img.alt);
        gallery.appendChild(img);
      }
      body.appendChild(gallery);
    }

    turn.appendChild(label);
    turn.appendChild(body);
    // 自分の送信時は必ず最下部に移動して追従を再開する
    stickToBottom = true;
    jumpBottom.classList.add("hidden");
    scrollToBottom(true);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
      reader.readAsDataURL(file);
    });
  }

  function showAttachmentError(message) {
    if (!attachmentTray) {
      return;
    }
    attachmentTray.classList.remove("hidden");
    let errorEl = attachmentTray.querySelector(".attachment-error");
    if (!errorEl) {
      errorEl = document.createElement("div");
      errorEl.className = "attachment-error";
      attachmentTray.prepend(errorEl);
    }
    errorEl.textContent = message;
  }

  function clearAttachmentError() {
    attachmentTray?.querySelector(".attachment-error")?.remove();
  }

  function renderAttachmentTray() {
    if (!attachmentTray) {
      return;
    }

    clearAttachmentError();
    attachmentTray.querySelectorAll(".attachment-chip").forEach((node) => node.remove());

    if (pendingAttachments.length === 0) {
      attachmentTray.classList.add("hidden");
      return;
    }

    attachmentTray.classList.remove("hidden");
    for (const attachment of pendingAttachments) {
      const chip = document.createElement("div");
      chip.className = "attachment-chip";
      chip.dataset.id = attachment.id;

      const preview = document.createElement("img");
      preview.src = attachment.dataUrl;
      preview.alt = attachment.name || "Attached image";
      bindImagePreview(preview, attachment.dataUrl, preview.alt);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "attachment-remove";
      removeBtn.setAttribute("aria-label", "Remove image");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        pendingAttachments = pendingAttachments.filter((item) => item.id !== attachment.id);
        renderAttachmentTray();
      });

      chip.appendChild(preview);
      chip.appendChild(removeBtn);
      attachmentTray.appendChild(chip);
    }
  }

  async function addAttachmentFromFile(file) {
    if (!file || !ALLOWED_IMAGE_TYPES.has(file.type)) {
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showAttachmentError(t("imageTooLarge"));
      return;
    }
    if (pendingAttachments.length >= MAX_IMAGE_ATTACHMENTS) {
      showAttachmentError(t("maxImages", MAX_IMAGE_ATTACHMENTS));
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      pendingAttachments.push({
        id: String(++attachmentIdCounter),
        mimeType: file.type === "image/jpg" ? "image/jpeg" : file.type,
        dataUrl,
        name: file.name || "image",
      });
      renderAttachmentTray();
    } catch {
      showAttachmentError(t("imageLoadFailed"));
    }
  }

  function getAttachmentsForSend() {
    return pendingAttachments.map((attachment) => ({
      mimeType: attachment.mimeType,
      data: attachment.dataUrl.replace(/^data:[^;]+;base64,/, ""),
    }));
  }

  function clearAttachments() {
    pendingAttachments = [];
    renderAttachmentTray();
  }

  function ensureAssistantTurn() {
    if (!currentTurn || !currentTurn.classList.contains("turn-assistant")) {
      currentTurn = ensureTurn("assistant");

      const label = document.createElement("div");
      label.className = "turn-label";
      label.textContent = "Agent";

      activityPanel = document.createElement("div");
      activityPanel.className = "activity-panel";

      responsePanel = document.createElement("div");
      responsePanel.className = "response-panel";

      currentTurn.appendChild(label);
      currentTurn.appendChild(activityPanel);
      currentTurn.appendChild(responsePanel);
    }
    return currentTurn;
  }

  function ensureActivityPanel() {
    ensureAssistantTurn();
    return activityPanel;
  }

  function ensureAssistantText() {
    ensureAssistantTurn();
    if (!currentAssistantEl) {
      currentAssistantEl = document.createElement("div");
      currentAssistantEl.className = "assistant-text typing";
      responsePanel.appendChild(currentAssistantEl);
    }
    return currentAssistantEl;
  }

  function statusLabel(status) {
    switch (status) {
      case "completed":
      case "done":
        return "";
      case "failed":
      case "error":
        return "failed";
      case "running":
      case "in_progress":
        return "running";
      default:
        return "running";
    }
  }

  function updateExploredSummary(panel) {
    const done = panel.querySelectorAll(".explored-row.is-done").length;
    const total = toolRows.size;
    const summary = panel.querySelector(".explored-summary");

    if (total === 0) {
      summary.textContent = "Explored";
    } else if (done < total) {
      summary.textContent = `Explored ${total} tools`;
    } else {
      summary.textContent = `Explored ${total} ${total === 1 ? "tool" : "tools"}`;
    }
  }

  function ensureToolPanel() {
    if (!currentToolPanel) {
      const block = document.createElement("div");
      block.className = "explored-block collapsed";
      block.innerHTML = `
        <button class="explored-toggle" type="button" aria-expanded="false">
          <span class="chevron">▾</span>
          <span class="explored-summary">Explored</span>
        </button>
        <ul class="explored-list"></ul>
      `;

      block.querySelector(".explored-toggle").addEventListener("click", () => {
        const collapsed = block.classList.toggle("collapsed");
        block.querySelector(".explored-toggle").setAttribute("aria-expanded", collapsed ? "false" : "true");
      });

      ensureActivityPanel().appendChild(block);
      currentToolPanel = block;
      toolRows = new Map();
    }
    return currentToolPanel;
  }

  function updateToolActivity(msg) {
    const panel = ensureToolPanel();
    const list = panel.querySelector(".explored-list");
    const rowKey = msg.id || msg.title || `tool-${toolRows.size}`;
    const title = msg.title || "Tool";
    const st = statusLabel(msg.status);
    const isRunning = st === "running";

    let row = toolRows.get(rowKey);
    if (!row) {
      row = document.createElement("li");
      row.className = "explored-row";
      row.innerHTML = `<span class="dot"></span><span class="label"></span>`;
      list.appendChild(row);
      toolRows.set(rowKey, row);
    }

    row.className = `explored-row${isRunning ? " is-running" : " is-done"}`;
    row.querySelector(".label").textContent = title;
    updateExploredSummary(panel);
    scrollToBottom();
  }

  function finalizeToolPanel() {
    if (!currentToolPanel) return;
    updateExploredSummary(currentToolPanel);
    currentToolPanel.classList.add("collapsed");
    currentToolPanel = null;
    toolRows = new Map();
  }

  function settleThoughtBlocks() {
    document.querySelectorAll(".thought-block.is-live").forEach((block) => {
      block.classList.remove("is-live");
    });
  }

  function renderFileEditPreview(lines) {
    if (!lines || lines.length === 0) {
      return `<div class="file-edit-empty">${t("openFile")}</div>`;
    }

    return lines
      .map((line) => {
        const cls =
          line.type === "add" ? "diff-add" : line.type === "remove" ? "diff-remove" : "diff-context";
        return `<div class="diff-line ${cls}">${escapeHtml(line.text || " ")}</div>`;
      })
      .join("");
  }

  function formatEditStats(added, removed) {
    const parts = [];
    if (added > 0) parts.push(`+${added}`);
    if (removed > 0) parts.push(`-${removed}`);
    return parts.join(" ") || "+0";
  }

  function ensureFileEditsPanel() {
    if (!fileEditsPanel) {
      fileEditsPanel = document.createElement("div");
      fileEditsPanel.className = "file-edits-panel";
      ensureActivityPanel().appendChild(fileEditsPanel);
    }
    return fileEditsPanel;
  }

  function upsertFileEditCard(msg) {
    const panel = ensureFileEditsPanel();
    let card = fileEditCards.get(msg.id);

    if (!card) {
      card = document.createElement("button");
      card.type = "button";
      card.className = "file-edit-card";
      card.dataset.path = msg.path;
      panel.appendChild(card);
      fileEditCards.set(msg.id, card);

      card.addEventListener("click", () => {
        vscode.postMessage({ type: "openFile", path: msg.path, line: msg.line ?? 1 });
      });
    }

    const isRunning = !["completed", "done"].includes(msg.status);
    card.className = `file-edit-card${isRunning ? " is-running" : ""}`;
    card.dataset.path = msg.path;

    card.innerHTML = `
      <div class="file-edit-header">
        <span class="file-edit-icon">${escapeHtml(msg.icon || "📄")}</span>
        <span class="file-edit-name">${escapeHtml(msg.fileName || msg.path)}</span>
        <span class="file-edit-stats">${formatEditStats(msg.addedLines || 0, msg.removedLines || 0)}</span>
      </div>
      <div class="file-edit-preview">${renderFileEditPreview(msg.previewLines)}</div>
    `;

    scrollToBottom();
  }

  function resetTurnState() {
    currentTurn = null;
    currentAssistantEl = null;
    currentThinkingEl = null;
    currentToolPanel = null;
    toolRows = new Map();
    fileEditsPanel = null;
    fileEditCards = new Map();
    activityPanel = null;
    responsePanel = null;
    thinkingStart = 0;
  }

  function sendMessage() {
    const text = inputEl.value.trim();
    if ((!text && pendingAttachments.length === 0) || busy) {
      return;
    }
    closeSuggestMenu();
    vscode.postMessage({ type: "send", text, images: getAttachmentsForSend() });
    inputEl.value = "";
    renderContextPreview([]);
    clearAttachments();
    inputEl.style.height = "auto";
  }

  sendBtn.addEventListener("click", sendMessage);
  stopBtn.addEventListener("click", requestCancel);

  inputEl.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }

    const imageFiles = [];
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          imageFiles.push(file);
        }
      }
    }

    if (imageFiles.length === 0) {
      return;
    }

    e.preventDefault();
    void (async () => {
      for (const file of imageFiles) {
        await addAttachmentFromFile(file);
      }
    })();
  });

  inputEl.addEventListener("compositionstart", () => {
    isComposing = true;
  });
  inputEl.addEventListener("compositionend", () => {
    isComposing = false;
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.isComposing || isComposing) {
      return;
    }
    if (suggestState && suggestMenu && !suggestMenu.classList.contains("hidden")) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        suggestState.activeIndex = Math.min(
          suggestState.activeIndex + 1,
          suggestState.items.length - 1
        );
        renderSuggestMenu();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        suggestState.activeIndex = Math.max(suggestState.activeIndex - 1, 0);
        renderSuggestMenu();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applySuggestion(suggestState.activeIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSuggestMenu();
        return;
      }
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (isImageLightboxOpen()) {
        closeImageLightbox();
        return;
      }
      requestCancel();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
    updateSuggestFromInput();
    queueContextPreview();
  });

  inputEl.addEventListener("click", updateSuggestFromInput);
  inputEl.addEventListener("keyup", (e) => {
    if (isSuggestNavigationKey(e.key)) {
      return;
    }
    updateSuggestFromInput();
  });

  newChatBtn.addEventListener("click", () => {
    if (busy && !stopping) return;
    vscode.postMessage({ type: "newChat" });
  });

  historyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu("history");
  });

  usageBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: "openUsageDashboard" });
  });

  changesBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu("changes");
  });

  permissionsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu("permissions");
  });

  modePill.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu("mode");
  });

  modelPill.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu("model");
  });

  autoRunPill.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!sessionReady) return;
    vscode.postMessage({ type: "setAutoApprove", enabled: !autoApproveEnabled });
  });

  retryConnectBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "retryConnect" });
  });

  diagnoseBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "runDiagnostics" });
  });

  openSettingsBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "openSettings" });
  });

  modeMenu.addEventListener("click", (e) => e.stopPropagation());
  modelMenu.addEventListener("click", (e) => e.stopPropagation());
  historyMenu.addEventListener("click", (e) => e.stopPropagation());
  changesMenu.addEventListener("click", (e) => e.stopPropagation());
  permissionsMenu.addEventListener("click", (e) => e.stopPropagation());

  suggestMenu.addEventListener("mousedown", (e) => e.stopPropagation());

  document.addEventListener("click", () => {
    closeMenus();
    closeSuggestMenu();
  });
  window.addEventListener("resize", () => {
    closeMenus();
    if (suggestState) {
      positionSuggestMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (isImageLightboxOpen()) {
        e.preventDefault();
        closeImageLightbox();
        return;
      }
      if (openMenu) {
        e.preventDefault();
        closeMenus();
        return;
      }
      if (busy) {
        e.preventDefault();
        requestCancel();
      }
    }
  });

  imageLightbox?.addEventListener("click", (e) => {
    if (e.target === imageLightbox || e.target === imageLightboxClose) {
      closeImageLightbox();
    }
  });

  imageLightboxClose?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeImageLightbox();
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;

    switch (msg.type) {
      case "clear":
        threadEl.innerHTML = "";
        resetTurnState();
        clearAttachments();
        renderContextPreview([]);
        setRunning(false, false);
        dismissPermissionCards();
        stickToBottom = true;
        jumpBottom.classList.add("hidden");
        break;

      case "userMessage":
        appendUserMessage(msg.text || "", msg.images);
        break;

      case "assistantStart":
        resetTurnState();
        setRunning(true, false);
        break;

      case "running":
        setRunning(!!msg.running, !!msg.stopping);
        break;

      case "assistantChunk": {
        currentThinkingEl?.classList.remove("is-live");
        const el = ensureAssistantText();
        if (el.classList.contains("rendered")) {
          el.classList.remove("rendered");
          el.textContent = el.__raw || el.textContent || "";
          el.__raw = undefined;
        }
        el.textContent += msg.text;
        scrollToBottom();
        break;
      }

      case "thinking":
        if (msg.append) {
          if (!currentThinkingEl) {
            thinkingStart = Date.now();
            const block = document.createElement("div");
            block.className = "thought-block collapsed is-live";
            block.innerHTML = `
              <button class="thought-toggle" type="button">
                <span class="chevron">▾</span>
                <span class="thought-label">Thought for 1s</span>
              </button>
              <div class="thought-body"></div>
            `;
            block.querySelector(".thought-toggle").addEventListener("click", () => {
              block.classList.toggle("collapsed");
            });
            ensureActivityPanel().appendChild(block);
            currentThinkingEl = block;
          }
          currentThinkingEl.querySelector(".thought-body").textContent += msg.text;
          currentThinkingEl.querySelector(".thought-label").textContent =
            formatThoughtDuration(Date.now() - thinkingStart);
        }
        scrollToBottom();
        break;

      case "toolActivity":
        updateToolActivity(msg);
        break;

      case "permissionRequest":
        showPermissionCard(msg);
        break;

      case "fileEdit":
        upsertFileEditCard(msg);
        break;

      case "changeReview":
        changeReviewItems = msg.items || [];
        changesBtn.classList.toggle("has-items", changeReviewItems.length > 0);
        if (openMenu === "changes") {
          renderChangesMenu();
        }
        break;

      case "cancelled": {
        dismissPermissionCards();
        finalizeToolPanel();
        settleThoughtBlocks();
        if (currentAssistantEl) {
          currentAssistantEl.classList.remove("typing");
          renderAssistantContent(currentAssistantEl);
        }
        const note = document.createElement("div");
        note.className = "system-note";
        note.innerHTML = '<span class="system-note-text">⏹ Stopped</span>';
        threadEl.appendChild(note);
        resetTurnState();
        setRunning(false, false);
        scrollToBottom();
        break;
      }

      case "assistantDone":
        finalizeToolPanel();
        settleThoughtBlocks();
        if (currentAssistantEl) {
          currentAssistantEl.classList.remove("typing");
          renderAssistantContent(currentAssistantEl);
        }
        resetTurnState();
        setRunning(false, false);
        scrollToBottom();
        break;

      case "init":
        setBootState(msg.status, msg.message);
        break;

      case "diagnostics":
        renderDiagnostics(msg.results, msg.running);
        break;

      case "sessions":
        sessions = msg.sessions || [];
        currentSessionId = msg.currentSessionId || null;
        if (openMenu === "history") {
          renderHistoryMenu();
        }
        break;

      case "sessionLoading": {
        document.getElementById("sessionLoading")?.remove();
        const loading = document.createElement("div");
        loading.id = "sessionLoading";
        loading.className = "session-loading";
        loading.innerHTML = `<span class="boot-spinner"></span><span>${escapeHtml(msg.title || t("loading"))}</span>`;
        threadEl.appendChild(loading);
        scrollToBottom();
        break;
      }

      case "sessionLoaded":
        document.getElementById("sessionLoading")?.remove();
        if (msg.emptyHistory) {
          const note = document.createElement("div");
          note.className = "system-note";
          note.innerHTML =
            `<span class="system-note-text">${t("historyLoadFailed")}</span>`;
          threadEl.appendChild(note);
        }
        stickToBottom = true;
        scrollToBottom(true);
        break;

      case "system": {
        const note = document.createElement("div");
        note.className = "system-note";
        note.innerHTML = `<span class="system-note-text">${escapeHtml(msg.text || "")}</span>`;
        threadEl.appendChild(note);
        scrollToBottom();
        break;
      }

      case "settings":
        if (typeof msg.autoApprovePermissions === "boolean") {
          applyAutoRun(msg.autoApprovePermissions);
        }
        break;

      case "permissionState":
        permissionRules = msg.rules || [];
        permissionHistory = msg.history || [];
        if (openMenu === "permissions") {
          renderPermissionMenu();
        }
        break;

      case "suggestions": {
        const token = getCaretToken();
        if (!token || token.kind !== msg.kind || token.query !== msg.query) {
          break;
        }
        const items = msg.items || [];
        const prevIndex =
          suggestState &&
          suggestState.kind === token.kind &&
          suggestState.query === token.query
            ? suggestState.activeIndex
            : 0;
        suggestState = {
          kind: token.kind,
          query: token.query,
          replaceStart: token.replaceStart,
          replaceEnd: token.replaceEnd,
          prefix: token.prefix,
          items,
          activeIndex: Math.max(0, Math.min(prevIndex, items.length - 1)),
          requestId: suggestRequestId,
        };
        if (suggestState.items.length === 0) {
          closeSuggestMenu();
        } else {
          renderSuggestMenu();
        }
        break;
      }

      case "contextPreview":
        if (msg.text === contextPreviewText) {
          renderContextPreview(msg.items || [], msg.error);
        }
        break;

      case "config":
        applyConfig(msg);
        if (msg.ready) {
          currentSessionId = msg.sessionId || currentSessionId;
          setBootState("ready");
        }
        break;

      case "error": {
        finalizeToolPanel();
        settleThoughtBlocks();
        const err = document.createElement("div");
        err.className = "error-note";
        err.textContent = msg.text;
        threadEl.appendChild(err);
        if (currentAssistantEl) currentAssistantEl.classList.remove("typing");
        resetTurnState();
        setRunning(false, false);
        scrollToBottom();
        break;
      }
    }
  });

  setRunning(false, false);
  setBootState("loading", t("connecting"));
  vscode.postMessage({ type: "ready" });
})();
