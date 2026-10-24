import * as assert from "node:assert/strict";
import { test } from "node:test";
import { AcpClient } from "../acpClient";

// Feeds lines as if the agent had written them. Without a started process the
// client's answers go nowhere, which is fine for checking what it emits.
function clientFed(): { client: AcpClient; feed: (message: Record<string, unknown>) => void } {
  const client = new AcpClient({ agentPath: "agent", cwd: "/", autoApprovePermissions: false, clientVersion: "test" });
  const handleLine = (client as unknown as { handleLine(line: string): void }).handleLine.bind(client);
  return { client, feed: (message) => handleLine(JSON.stringify({ jsonrpc: "2.0", ...message })) };
}

function toolCall(sessionId: string, toolCallId: string): Record<string, unknown> {
  return {
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId, title: "Update TODOs", kind: "other" } },
  };
}

test("cursor/* requests belong to the session their tool call ran in", () => {
  const { client, feed } = clientFed();
  const seen: Array<[string, string | undefined]> = [];
  client.on("todos", (sessionId: string | undefined) => seen.push(["todos", sessionId]));
  client.on("askQuestion", ({ sessionId }: { sessionId?: string }) => seen.push(["askQuestion", sessionId]));
  client.on("createPlan", ({ sessionId }: { sessionId?: string }) => seen.push(["createPlan", sessionId]));

  // The real CLI sends these with a tool call id and no session id.
  feed(toolCall("session-a", "tc-1"));
  feed(toolCall("session-b", "tc-2"));
  feed(toolCall("session-a", "tc-3"));
  feed({ id: 1, method: "cursor/update_todos", params: { toolCallId: "tc-2", todos: [], merge: false } });
  feed({ id: 2, method: "cursor/ask_question", params: { toolCallId: "tc-1", questions: [] } });
  feed({ id: 3, method: "cursor/create_plan", params: { toolCallId: "tc-3", name: "Plan", todos: [] } });

  assert.deepEqual(seen, [
    ["todos", "session-b"],
    ["askQuestion", "session-a"],
    ["createPlan", "session-a"],
  ]);
});

test("a session id in the request wins over the tool call", () => {
  const { client, feed } = clientFed();
  let seen: string | undefined;
  client.on("todos", (sessionId: string | undefined) => (seen = sessionId));
  feed(toolCall("session-a", "tc-1"));
  feed({ id: 1, method: "cursor/update_todos", params: { sessionId: "session-z", toolCallId: "tc-1", todos: [] } });
  assert.equal(seen, "session-z");
});

test("todo updates are parsed with their merge flag", () => {
  const { client, feed } = clientFed();
  let seen: unknown;
  client.on("todos", (_sessionId: string | undefined, update: unknown) => (seen = update));
  feed({
    id: 1,
    method: "cursor/update_todos",
    params: { toolCallId: "tc", todos: [{ id: "1", content: "one", status: "completed" }], merge: true },
  });
  assert.deepEqual(seen, { todos: [{ id: "1", content: "one", status: "completed" }], merge: true });
});
