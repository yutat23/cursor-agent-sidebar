import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { resolveAgentPath } from "../acpClient";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-path-"));
const originalPath = process.env.PATH;
after(() => {
  process.env.PATH = originalPath;
  fs.rmSync(root, { recursive: true, force: true });
});

function binDir(name: string, commands: string[]): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const command of commands) {
    const file = path.join(dir, process.platform === "win32" ? `${command}.cmd` : command);
    fs.writeFileSync(file, "#!/bin/sh\n");
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

const grok = binDir("grok", ["agent", "grok"]);
const cursor = binDir("cursor", ["agent", "cursor-agent"]);
const cursorOld = binDir("cursor-old", ["agent"]);

test("prefers cursor-agent even when Grok's agent comes first on PATH", () => {
  process.env.PATH = [grok, cursor].join(path.delimiter);
  assert.equal(resolveAgentPath(""), "cursor-agent");
  assert.equal(resolveAgentPath(undefined), "cursor-agent");
});

test("falls back to agent when cursor-agent is not installed", () => {
  process.env.PATH = cursorOld;
  assert.equal(resolveAgentPath(""), "agent");
});

test("a configured command always wins", () => {
  process.env.PATH = [grok, cursor].join(path.delimiter);
  assert.equal(resolveAgentPath("  /opt/cursor/agent  "), "/opt/cursor/agent");
  assert.equal(resolveAgentPath("agent"), "agent");
});
