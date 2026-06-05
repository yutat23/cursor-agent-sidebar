(function () {
  const vscode = acquireVsCodeApi();

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
  const historyBtn = document.getElementById("historyBtn");
  const historyMenu = document.getElementById("historyMenu");
  const historyLabel = document.getElementById("historyLabel");
  const bootOverlay = document.getElementById("bootOverlay");
  const bootLabel = document.getElementById("bootLabel");
  const taskStatus = document.getElementById("taskStatus");
  const taskLabel = document.getElementById("taskLabel");

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
  let openMenu = null;
  let suggestState = null;
  let suggestTimer = null;
  let suggestRequestId = 0;

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

    taskLabel.textContent = isStopping ? "停止しています..." : "エージェント実行中...";
    inputEl.disabled = running;
    inputEl.placeholder = running ? "Add a follow-up" : "Plan, @ for context, Enter to send";

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
      ? "自動実行 ON — ツールは確認なしで実行されます（--yolo）"
      : "自動実行 OFF — クリックで ON（--yolo 相当）";
  }

  function setBootState(status, message) {
    if (status === "loading") {
      bootOverlay.classList.remove("hidden");
      bootLabel.textContent = message || "エージェントに接続中...";
      sessionReady = false;
      updateInteractiveState();
      return;
    }

    if (status === "error") {
      bootOverlay.classList.remove("hidden");
      bootLabel.textContent = message || "接続に失敗しました";
      sessionReady = false;
      updateInteractiveState();
      return;
    }

    if (status === "ready") {
      bootOverlay.classList.add("hidden");
      sessionReady = true;
      updateInteractiveState();
    }
  }

  function closeMenus() {
    modeMenu.classList.add("hidden");
    modelMenu.classList.add("hidden");
    historyMenu.classList.add("hidden");
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
    suggestMenu.style.width = `${Math.min(360, Math.max(220, rect.width))}px`;
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
      btn.className = "suggest-item" + (index === suggestState.activeIndex ? " is-active" : "");
      btn.dataset.index = String(index);
      const kindLabel =
        item.kind === "skill"
          ? "Skill"
          : item.kind === "command"
            ? "Command"
            : item.kind === "folder"
              ? "Folder"
              : "File";
      btn.innerHTML = `
        <span class="suggest-kind">${kindLabel}</span>
        <span class="suggest-body">
          <span class="suggest-label">${escapeHtml(item.label)}</span>
          ${item.detail ? `<span class="suggest-detail">${escapeHtml(item.detail)}</span>` : ""}
        </span>
      `;
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
    if (typeof config.autoApprovePermissions === "boolean") {
      applyAutoRun(config.autoApprovePermissions);
    }
  }

  function formatRelativeTime(iso) {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "たった今";
    if (mins < 60) return `${mins}分前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}時間前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}日前`;
    return date.toLocaleDateString("ja-JP", { month: "short", day: "numeric" });
  }

  function renderHistoryMenu() {
    historyMenu.innerHTML = "";
    const list = document.createElement("div");
    list.className = "picker-list";

    if (!sessions.length) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = sessionReady ? "履歴がありません" : "読み込み中...";
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

  function renderModeMenu() {
    if (!sessionConfig?.modes?.length) {
      modeMenu.innerHTML = '<div class="picker-empty">読み込み中...</div>';
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

  function renderModelMenu(filter) {
    if (!sessionConfig?.models?.length) {
      modelMenu.innerHTML = '<div class="picker-empty">読み込み中...</div>';
      return;
    }
    const query = (filter || "").trim().toLowerCase();
    modelMenu.innerHTML = "";

    const search = document.createElement("input");
    search.type = "text";
    search.className = "picker-search";
    search.placeholder = "Search models";
    search.value = filter || "";
    search.addEventListener("input", () => renderModelMenu(search.value));
    search.addEventListener("keydown", (e) => e.stopPropagation());
    modelMenu.appendChild(search);

    const list = document.createElement("div");
    list.className = "picker-list";

    const models = sessionConfig.models.filter((m) => {
      if (!query) return true;
      return m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query);
    });

    for (const model of models) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "picker-item" + (model.id === sessionConfig.currentModelId ? " is-selected" : "");
      btn.innerHTML = `
        <span class="picker-item-body">
          <span class="picker-item-title">${model.name}</span>
        </span>
        ${model.id === sessionConfig.currentModelId ? '<span class="picker-check">✓</span>' : ""}
      `;
      btn.addEventListener("click", () => {
        closeMenus();
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

    modelMenu.appendChild(list);
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
    }
  }

  function scrollToBottom() {
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  function dismissPermissionCards() {
    document.querySelectorAll(".permission-card.pending").forEach((card) => {
      card.classList.remove("pending");
      card.classList.add("dismissed");
      const actions = card.querySelector(".permission-actions");
      if (actions) {
        actions.innerHTML = '<span class="permission-resolved">キャンセルされました</span>';
      }
    });
  }

  function showPermissionCard(msg) {
    const card = document.createElement("div");
    card.className = "permission-card pending";
    card.dataset.requestId = msg.id;

    const icon = msg.icon || "🔧";
    const title = escapeHtml(msg.title || "ツールの実行");
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
        <button type="button" class="perm-btn perm-allow" data-decision="allow-once">許可</button>
        <button type="button" class="perm-btn perm-always" data-decision="allow-always">常に許可</button>
        <button type="button" class="perm-btn perm-deny" data-decision="reject-once">拒否</button>
      </div>
    `;

    card.querySelectorAll(".perm-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const decision = btn.dataset.decision;
        const label =
          decision === "allow-once" ? "許可しました" :
          decision === "allow-always" ? "常に許可しました" : "拒否しました";

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

  function renderAssistantContent(el) {
    const text = el.textContent || "";
    if (!text.trim()) {
      return;
    }

    let html = escapeHtml(text);

    html = html.replace(/```[\w.-]*\n([\s\S]*?)```/g, (_, code) => {
      return `<pre class="code-block"><code>${code.replace(/\n$/, "")}</code></pre>`;
    });

    html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\n/g, "<br>");

    el.innerHTML = html;
    el.classList.add("rendered");
  }

  function appendUserMessage(text) {
    const turn = ensureTurn("user");
    const label = document.createElement("div");
    label.className = "turn-label";
    label.textContent = "You";
    const el = document.createElement("div");
    el.className = "user-text";
    el.textContent = text;
    turn.appendChild(label);
    turn.appendChild(el);
    scrollToBottom();
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

  function renderFileEditPreview(lines) {
    if (!lines || lines.length === 0) {
      return '<div class="file-edit-empty">クリックしてファイルを開く</div>';
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
    if (!text || busy) return;
    closeSuggestMenu();
    vscode.postMessage({ type: "send", text });
    inputEl.value = "";
    inputEl.style.height = "auto";
  }

  sendBtn.addEventListener("click", sendMessage);
  stopBtn.addEventListener("click", requestCancel);

  inputEl.addEventListener("keydown", (e) => {
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

  modeMenu.addEventListener("click", (e) => e.stopPropagation());
  modelMenu.addEventListener("click", (e) => e.stopPropagation());
  historyMenu.addEventListener("click", (e) => e.stopPropagation());

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

  window.addEventListener("message", (event) => {
    const msg = event.data;

    switch (msg.type) {
      case "clear":
        threadEl.innerHTML = "";
        resetTurnState();
        setRunning(false, false);
        dismissPermissionCards();
        break;

      case "userMessage":
        appendUserMessage(msg.text);
        break;

      case "assistantStart":
        resetTurnState();
        setRunning(true, false);
        break;

      case "running":
        setRunning(!!msg.running, !!msg.stopping);
        break;

      case "assistantChunk": {
        const el = ensureAssistantText();
        if (el.classList.contains("rendered")) {
          el.classList.remove("rendered");
          el.textContent = el.textContent || "";
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
            block.className = "thought-block collapsed";
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

      case "cancelled": {
        dismissPermissionCards();
        finalizeToolPanel();
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
        loading.innerHTML = `<span class="boot-spinner"></span><span>${escapeHtml(msg.title || "読み込み中...")}</span>`;
        threadEl.appendChild(loading);
        scrollToBottom();
        break;
      }

      case "sessionLoaded":
        document.getElementById("sessionLoading")?.remove();
        scrollToBottom();
        break;

      case "settings":
        if (typeof msg.autoApprovePermissions === "boolean") {
          applyAutoRun(msg.autoApprovePermissions);
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

      case "config":
        applyConfig(msg);
        if (msg.ready) {
          currentSessionId = msg.sessionId || currentSessionId;
          setBootState("ready");
        }
        break;

      case "error": {
        finalizeToolPanel();
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
  setBootState("loading", "エージェントに接続中...");
  vscode.postMessage({ type: "ready" });
})();
