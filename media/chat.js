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
  const emptyState = document.getElementById("emptyState");
  const jumpBottom = document.getElementById("jumpBottom");

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
    inputEl.placeholder = running
      ? "フォローアップを入力..."
      : "質問や指示を入力（@ でコンテキスト追加）";

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
      btn.className = "suggest-item" + (index === suggestState.activeIndex ? " is-active" : "");
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

  // ── 軽量シンタックスハイライト ──
  const KEYWORD_RE = new RegExp(
    "\\b(" +
      [
        "const", "let", "var", "function", "return", "if", "else", "elif", "for", "while",
        "do", "switch", "case", "default", "break", "continue", "class", "struct", "enum",
        "interface", "type", "extends", "implements", "new", "this", "super", "import",
        "export", "from", "as", "async", "await", "try", "catch", "finally", "throw",
        "throws", "yield", "in", "of", "is", "not", "and", "or", "def", "lambda", "pass",
        "with", "raise", "fn", "mut", "impl", "use", "pub", "match", "func", "package",
        "go", "void", "int", "float", "double", "bool", "boolean", "string", "char",
        "null", "nil", "None", "undefined", "true", "false", "True", "False", "public",
        "private", "protected", "static", "final", "abstract", "override", "virtual",
        "namespace", "using", "echo", "then", "fi", "done", "esac", "select", "where",
      ].join("|") +
      ")\\b",
    "g"
  );

  function commentPattern(lang) {
    const l = (lang || "").toLowerCase();
    if (
      ["py", "python", "rb", "ruby", "sh", "bash", "shell", "zsh", "yaml", "yml",
        "toml", "ini", "dockerfile", "makefile", "ps1", "powershell", "r", "perl"].includes(l)
    ) {
      return "#[^\\n]*";
    }
    if (["html", "xml", "svg", "vue"].includes(l)) {
      return "<!--[\\s\\S]*?-->";
    }
    if (l === "sql") {
      return "--[^\\n]*";
    }
    if (
      ["js", "ts", "jsx", "tsx", "javascript", "typescript", "java", "c", "cpp", "cs",
        "csharp", "go", "rust", "php", "swift", "kotlin", "scala", "css", "scss", "less",
        "json", "jsonc"].includes(l)
    ) {
      return "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/";
    }
    // 言語不明: 主要なコメント記法をまとめて対象にする
    return "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|#[^\\n]*";
  }

  function highlightPlain(text) {
    let html = escapeHtml(text);
    html = html.replace(KEYWORD_RE, '<span class="tok-keyword">$1</span>');
    html = html.replace(
      /\b(0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?)\b/g,
      '<span class="tok-number">$1</span>'
    );
    return html;
  }

  function highlightCode(code, lang) {
    // コメント・文字列を先に確定し、残りにキーワード・数値を適用する
    const re = new RegExp(
      "(" + commentPattern(lang) + ")" +
        "|(\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'|`(?:\\\\.|[^`\\\\])*`)",
      "g"
    );
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(code))) {
      out += highlightPlain(code.slice(last, m.index));
      const cls = m[1] !== undefined ? "tok-comment" : "tok-string";
      out += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
      last = re.lastIndex;
    }
    out += highlightPlain(code.slice(last));
    return out;
  }

  // ── テーブル ──
  function splitTableRow(line) {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function isTableSeparator(line) {
    if (!line || !line.includes("|") || !line.includes("-")) return false;
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
  }

  function renderMarkdown(text) {
    // フェンス付きコードブロックを退避してから全体をエスケープする
    const codeBlocks = [];
    const work = text.replace(/```([\w.+#-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.push({ lang, code: code.replace(/\n$/, "") }) - 1;
      return `\u0000CODE${idx}\u0000`;
    });

    let html = escapeHtml(work);

    // インライン要素
    html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" title="$2">$1</a>'
    );

    // 行単位の要素（テーブル・見出し・リスト・区切り線）
    const out = [];
    const lines = html.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // テーブル: ヘッダー行 + 区切り行（|---|---|）で始まるブロック
      if (/^\s*\|.*\|\s*$/.test(line) && isTableSeparator(lines[i + 1])) {
        const headers = splitTableRow(line);
        const aligns = splitTableRow(lines[i + 1]).map((cell) => {
          if (/^:-+:$/.test(cell)) return "center";
          if (/^-+:$/.test(cell)) return "right";
          return "";
        });
        i += 2;
        const bodyRows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          bodyRows.push(splitTableRow(lines[i]));
          i++;
        }
        const alignAttr = (idx) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "");
        let table = '<div class="table-wrap"><table class="md-table"><thead><tr>';
        headers.forEach((h, idx) => {
          table += `<th${alignAttr(idx)}>${h}</th>`;
        });
        table += "</tr></thead>";
        if (bodyRows.length) {
          table += "<tbody>";
          for (const row of bodyRows) {
            table += "<tr>";
            headers.forEach((_, idx) => {
              table += `<td${alignAttr(idx)}>${row[idx] ?? ""}</td>`;
            });
            table += "</tr>";
          }
          table += "</tbody>";
        }
        table += "</table></div>";
        out.push(table);
        continue;
      }

      i++;

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        out.push(`<div class="md-h md-h${heading[1].length}">${heading[2]}</div>`);
        continue;
      }
      const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
      if (bullet) {
        const indent = Math.min(Math.floor(bullet[1].length / 2), 3) * 14;
        out.push(
          `<div class="md-li" style="margin-left:${indent}px"><span class="md-bullet"></span><span>${bullet[2]}</span></div>`
        );
        continue;
      }
      const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
      if (numbered) {
        const indent = Math.min(Math.floor(numbered[1].length / 2), 3) * 14;
        out.push(
          `<div class="md-li" style="margin-left:${indent}px"><span class="md-num">${numbered[2]}.</span><span>${numbered[3]}</span></div>`
        );
        continue;
      }
      if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
        out.push('<hr class="md-hr">');
        continue;
      }
      out.push(line === "" ? '<div class="md-space"></div>' : `<div class="md-p">${line}</div>`);
    }
    html = out.join("");

    // コードブロックを復元
    html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => {
      const block = codeBlocks[Number(i)];
      const lang = block.lang ? `<span class="code-lang">${escapeHtml(block.lang)}</span>` : "<span></span>";
      return (
        '<div class="code-wrap"><div class="code-head">' +
        lang +
        `<button class="copy-btn code-copy" type="button" title="コピー">${COPY_ICON}</button>` +
        `</div><pre class="code-block"><code>${highlightCode(block.code, block.lang)}</code></pre></div>`
      );
    });

    return html;
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
    copyBtn.title = "メッセージをコピー";
    copyBtn.innerHTML = COPY_ICON;
    el.appendChild(copyBtn);

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
    // 自分の送信時は必ず最下部に移動して追従を再開する
    stickToBottom = true;
    jumpBottom.classList.add("hidden");
    scrollToBottom(true);
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
        stickToBottom = true;
        jumpBottom.classList.add("hidden");
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
        stickToBottom = true;
        scrollToBottom(true);
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
  setBootState("loading", "エージェントに接続中...");
  vscode.postMessage({ type: "ready" });
})();
