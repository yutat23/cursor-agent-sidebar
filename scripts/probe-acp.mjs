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
const init = await send("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "probe", version: "0.0.1" },
});
console.log("INIT:", JSON.stringify(init, null, 2));

await send("authenticate", { methodId: "cursor_login" });

try {
  const list = await send("session/list", { cwd });
  console.log("LIST:", JSON.stringify(list, null, 2));
} catch (e) {
  console.log("LIST ERROR:", e);
}

proc.kill();
