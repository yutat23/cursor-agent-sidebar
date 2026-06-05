import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";

const proc = spawn("agent", ["acp"], { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
const rl = readline.createInterface({ input: proc.stdout });
let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const w = pending.get(msg.id);
    if (w) {
      pending.delete(msg.id);
      msg.error ? w.reject(msg.error) : w.resolve(msg.result);
    }
  }
});

const cwd = process.cwd();
await send("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
  clientInfo: { name: "probe", version: "0.0.1" },
});
await send("authenticate", { methodId: "cursor_login" });
const { sessionId } = await send("session/new", { cwd, mcpServers: [] });

const readme = fs.readFileSync("package.json", "utf8").slice(0, 500);

const variants = [
  { label: "text only @", prompt: [{ type: "text", text: "What is in @package.json? Keep answer to one line." }] },
  {
    label: "text + resource",
    prompt: [
      { type: "resource", uri: `file://${cwd.replace(/\\/g, "/")}/package.json` },
      { type: "text", text: "Summarize this file in one line." },
    ],
  },
  {
    label: "text with path block",
    prompt: [
      {
        type: "text",
        text: `Context from package.json:\n\`\`\`\n${readme}\n\`\`\`\nSummarize in one line.`,
      },
    ],
  },
];

for (const v of variants) {
  try {
    const { sessionId: sid } = await send("session/new", { cwd, mcpServers: [] });
    const result = await send("session/prompt", { sessionId: sid, prompt: v.prompt });
    console.log(v.label, "OK", result.stopReason);
  } catch (e) {
    console.log(v.label, "FAIL", e.message || e);
  }
}

proc.kill();
