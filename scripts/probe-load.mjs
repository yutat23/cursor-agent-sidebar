import { spawn } from "node:child_process";
import * as readline from "node:readline";

const proc = spawn("agent", ["acp"], { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
const rl = readline.createInterface({ input: proc.stdout });
let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const updates = [];

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "session/update") {
    updates.push(msg.params?.update);
    return;
  }
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
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "probe", version: "0.0.1" },
});
await send("authenticate", { methodId: "cursor_login" });

const list = await send("session/list", { cwd });
const sessionId = list.sessions?.[0]?.sessionId;
if (!sessionId) {
  console.log("No sessions");
  proc.kill();
  process.exit(0);
}

const loaded = await send("session/load", { sessionId, cwd, mcpServers: [] });
console.log("LOAD RESULT:", JSON.stringify(loaded, null, 2));
console.log("UPDATES COUNT:", updates.length);
console.log("UPDATE TYPES:", [...new Set(updates.map((u) => u?.sessionUpdate))]);
console.log("SAMPLE:", JSON.stringify(updates.slice(0, 5), null, 2));

proc.kill();
