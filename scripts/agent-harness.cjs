#!/usr/bin/env node
// End-to-end checks against the real Cursor CLI. Runs the compiled
// ChatViewProvider (dist/) with a stand-in for the vscode module, plays the
// webview's side of the conversation, and checks what the view is sent.
//
// Needs a signed-in Cursor CLI on PATH and uses real agent requests.
//
//   npm run compile
//   node scripts/agent-harness.cjs <scenario|all>     (VERBOSE=1 logs every message)
//
// Scenarios: new-chat, return-running, stop, todos, question, mode
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCENARIOS = ["new-chat", "return-running", "stop", "todos", "question", "mode"];
const extDir = path.resolve(__dirname, "..");
const scenario = process.argv[2];

if (scenario === "all") {
  let failed = 0;
  for (const name of SCENARIOS) {
    console.log(`\n### ${name}`);
    const result = spawnSync(process.execPath, [__filename, name], { stdio: "inherit" });
    if (result.status !== 0) {
      failed++;
    }
  }
  console.log(failed ? `\n${failed} scenario(s) failed` : "\nall scenarios passed");
  process.exit(failed ? 1 : 0);
}
if (!SCENARIOS.includes(scenario)) {
  console.error(`usage: node scripts/agent-harness.cjs <${[...SCENARIOS, "all"].join("|")}>`);
  process.exit(2);
}

// Scenarios that edit files run in agent mode in a throwaway folder; the rest
// only read this repository in ask mode.
const editsFiles = scenario === "todos";
const workspaceDir = editsFiles ? fs.mkdtempSync(path.join(os.tmpdir(), "agent-harness-ws-")) : extDir;
const verbose = process.env.VERBOSE === "1";
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5) + "s", ...a);

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) {
    failures++;
  }
  log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
}

// --- vscode stand-in -------------------------------------------------------
const uri = (p) => ({ fsPath: p, path: p, toString: () => p });
const globalStore = new Map([["cursorAgent.mode", editsFiles ? "agent" : "ask"]]);
const vscode = {
  env: { language: "en", openExternal: async () => true },
  window: {
    createOutputChannel: () => ({ appendLine: (line) => verbose && log("  [output]", line.slice(0, 160)), dispose() {} }),
    showWarningMessage: async () => undefined,
    showTextDocument: async () => undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: uri(workspaceDir) }],
    getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    findFiles: async () => [],
    openTextDocument: async () => ({}),
  },
  commands: { executeCommand: async () => undefined },
  Uri: {
    file: uri,
    joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
    parse: (s) => uri(s),
  },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { One: 1 },
  Position: class {},
  Range: class {},
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "vscode" ? "vscode" : resolveFilename.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscode };

const { ChatViewProvider } = require(path.join(extDir, "dist", "chatViewProvider.js"));
const provider = new ChatViewProvider(uri(extDir), {
  subscriptions: [],
  extension: { packageJSON: { version: "harness" } },
  globalState: {
    get: (key, fallback) => (globalStore.has(key) ? globalStore.get(key) : fallback),
    update: async (key, value) => void globalStore.set(key, value),
  },
  globalStorageUri: uri(fs.mkdtempSync(path.join(os.tmpdir(), "agent-harness-storage-"))),
  globalStoragePath: "",
});

// --- webview stand-in ------------------------------------------------------
const posted = [];
const waiters = new Set();
let lastSessionId;
const listeners = [];
provider.resolveWebviewView(
  {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (u) => u,
      onDidReceiveMessage: (fn) => (listeners.push(fn), { dispose() {} }),
      postMessage: async (message) => {
        posted.push(message);
        if (message.type === "config") {
          lastSessionId = message.sessionId;
        }
        if (verbose && !["assistantChunk", "thinking", "usage"].includes(message.type)) {
          log("→", JSON.stringify(message).slice(0, 160));
        }
        for (const waiter of [...waiters]) {
          waiter(message);
        }
        return true;
      },
    },
    show() {},
    onDidDispose: () => ({ dispose() {} }),
  },
  {},
  {}
);

const send = (message) => {
  if (verbose) {
    log("←", JSON.stringify(message));
  }
  for (const fn of listeners) {
    fn(message);
  }
};
const waitFor = (predicate, ms = 90000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error("timed out waiting for a message"));
    }, ms);
    const waiter = (message) => {
      if (predicate(message)) {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(message);
      }
    };
    waiters.add(waiter);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const since = (index, type) => posted.slice(index).filter((m) => m.type === type);
const textSince = (index) => since(index, "assistantChunk").map((m) => m.text).join("");

const LONG_PROMPT = "Read README.md and package.json in this repository, then explain its structure in detail.";

async function startAnswer() {
  send({ type: "send", text: LONG_PROMPT });
  let chunks = 0;
  await waitFor((m) => m.type === "assistantChunk" && ++chunks >= 5, 120000);
}

async function newChat(from) {
  send({ type: "newChat" });
  await waitFor((m) => m.type === "config" && m.sessionId !== from);
  return lastSessionId;
}

async function open(sessionId) {
  send({ type: "selectSession", sessionId });
  await waitFor((m) => m.type === "config" && m.sessionId === sessionId);
}

// --- scenarios ---------------------------------------------------------------
const scenarios = {
  // New chat while answering: nothing of the old chat leaks in; it finishes in
  // the background and shows in full when reopened.
  async "new-chat"(a) {
    await startAnswer();
    const iNew = posted.length;
    const b = await newChat(a);
    check("old chat's output stays out of the new chat", since(iNew, "assistantChunk").length + since(iNew, "toolActivity").length + since(iNew, "assistantStart").length === 0);

    const iB = posted.length;
    send({ type: "send", text: "Reply with just: ok" });
    await waitFor((m) => m.type === "assistantDone", 90000);
    check("the new chat answers while the old one runs", /ok/i.test(textSince(iB)), JSON.stringify(textSince(iB).slice(0, 40)));

    await sleep(30000);
    const iA = posted.length;
    await open(a);
    const done = since(iA, "assistantDone");
    check("the old chat replays its question and answer", since(iA, "userMessage").length === 1 && textSince(iA).length > 200, `${textSince(iA).length} chars`);
    check("the old chat's turn finished in the background", done.some((m) => m.stopReason === "end_turn" && m.endedAt));
    await open(b);
  },

  // Back to a chat that is still running: its progress so far replays and the
  // rest streams in, with the running state restored.
  async "return-running"(a) {
    await startAnswer();
    await newChat(a);
    const iBack = posted.length;
    await open(a);
    check("the running chat comes back as running", since(iBack, "running").some((m) => m.running));
    await waitFor((m) => m.type === "assistantDone" && m.stopReason !== "replay", 150000);
    check("its answer streams in and the turn ends", textSince(iBack).length > 200, `${textSince(iBack).length} chars`);
  },

  // A new chat starts in the mode last picked (the CLI ignores it in session/new).
  async mode(a) {
    send({ type: "setMode", modeId: "plan" });
    await waitFor((m) => m.type === "config" && m.currentModeId === "plan");
    await newChat(a);
    const config = posted.filter((m) => m.type === "config").at(-1);
    check("a new chat starts in the mode last picked", config.currentModeId === "plan", config.currentModeId);
    send({ type: "setMode", modeId: "ask" });
    await waitFor((m) => m.type === "config" && m.currentModeId === "ask");
  },

  async stop() {
    await startAnswer();
    send({ type: "cancel" });
    await waitFor((m) => m.type === "cancelled", 15000);
    const iAfter = posted.length;
    await sleep(3000);
    check("nothing streams after stopping", since(iAfter, "assistantChunk").length === 0);
  },

  async todos(a) {
    const i0 = posted.length;
    send({
      type: "send",
      text: "Use your todo list tool to track these three steps and mark each one done as you go: 1) create hello.py printing hello, 2) create bye.py printing bye, 3) create README.md describing both. Do not run shell commands.",
    });
    await waitFor((m) => m.type === "assistantDone", 180000);
    const cards = since(i0, "todos");
    check("todo updates reach the view", cards.length > 0, `${cards.length} updates`);
    check("the last update has every step done", cards.at(-1)?.todos.every((t) => t.status === "completed"));
    check("no 'Update TODOs' activity rows", since(i0, "toolActivity").every((m) => !/todo/i.test(String(m.title))));
    check("the agent was not left waiting", ["hello.py", "bye.py", "README.md"].every((f) => fs.existsSync(path.join(workspaceDir, f))));

    await newChat(a);
    const iBack = posted.length;
    await open(a);
    const replayed = since(iBack, "todos");
    check("the card replays once, in its final state", replayed.length === 1 && replayed[0].todos.every((t) => t.status === "completed"));

    // The CLI's todo requests name only a tool call, not a session; a chat in
    // the background must still keep its own list.
    const files = ["one.py", "two.py"];
    send({
      type: "send",
      text: "Use your todo list tool to track two steps and mark each done as you go: 1) create one.py printing 1, 2) create two.py printing 2. Do not run shell commands.",
    });
    await waitFor((m) => m.type === "todos", 120000);
    const b = await newChat(a);
    const iB = posted.length;
    for (let waited = 0; waited < 120000 && !files.every((f) => fs.existsSync(path.join(workspaceDir, f))); waited += 1000) {
      await sleep(1000);
    }
    await sleep(5000);
    check("a background chat's todos stay out of the shown chat", since(iB, "todos").length === 0);
    const iA = posted.length;
    await open(a);
    const last = since(iA, "todos").at(-1);
    check("the background chat's card has its steps done", last?.todos.some((t) => /one\.py/.test(t.content)) && last.todos.every((t) => t.status === "completed"));
    await open(b);
  },

  // The agent rarely asks on request, so the question events are raised on the
  // client directly; everything from the provider to the view is real.
  async question(a) {
    const client = provider.client;
    const ask = (questions) => {
      const abort = new AbortController();
      const answered = new Promise((resolve) =>
        client.emit("askQuestion", { sessionId: a, questions, signal: abort.signal, resolve })
      );
      return { abort, answered };
    };

    const card1Seen = waitFor((m) => m.type === "questionRequest");
    const q1 = ask([
      { id: "lang", prompt: "Which language?", options: [{ id: "ts", label: "TypeScript" }, { id: "py", label: "Python" }] },
      { id: "extras", prompt: "Extras?", allowMultiple: true, options: [{ id: "tests", label: "Tests" }, { id: "ci", label: "CI" }] },
    ]);
    const card1 = await card1Seen;
    check("the question shows as a card", card1.questions[1].allowMultiple === true);
    const answers = [
      { questionId: "lang", selectedOptionIds: ["py"] },
      { questionId: "extras", selectedOptionIds: ["tests", "ci"] },
    ];
    send({ type: "questionResponse", id: card1.id, answers });
    check("the answer reaches the agent", JSON.stringify(await q1.answered) === JSON.stringify(answers));

    await newChat(a);
    const iOther = posted.length;
    const q2 = ask([{ id: "go", prompt: "Proceed?", options: [{ id: "yes", label: "Yes" }] }]);
    await sleep(300);
    check("a background chat's question stays out of the shown chat", since(iOther, "questionRequest").length === 0);
    const iBack = posted.length;
    await open(a);
    const pending = since(iBack, "questionRequest");
    check("it waits as the only pending card when going back", pending.length === 1 && pending[0].questions[0].id === "go");
    send({ type: "questionResponse", id: pending[0].id, answers: null });
    check("skipping tells the agent the questions were skipped", (await q2.answered) === null);

    const card3Seen = waitFor((m) => m.type === "questionRequest" && m.questions[0].id === "x");
    const q3 = ask([{ id: "x", prompt: "Withdrawn?", options: [{ id: "a", label: "A" }] }]);
    await card3Seen;
    q3.abort.abort();
    await newChat(a);
    const iBack2 = posted.length;
    await open(a);
    check("a withdrawn question is not replayed", since(iBack2, "questionRequest").length === 0);
  },
};

setTimeout(() => {
  log("FAIL scenario timed out");
  process.exit(1);
}, 300000).unref();

(async () => {
  send({ type: "ready" });
  await waitFor((m) => m.type === "init" && m.status === "ready");
  await sleep(500);
  await scenarios[scenario](lastSessionId);
})()
  .catch((err) => check("scenario ran to the end", false, err.message))
  .finally(() => {
    if (editsFiles) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
    process.exit(failures ? 1 : 0);
  });
