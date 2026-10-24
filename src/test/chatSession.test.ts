import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ChatSession } from "../chatSession";

test("streamed chunks are recorded as one message", () => {
  const session = new ChatSession("s");
  session.record({ type: "assistantStart" });
  session.record({ type: "assistantChunk", text: "Hel" });
  session.record({ type: "assistantChunk", text: "lo" });
  session.record({ type: "assistantDone", stopReason: "end_turn" });
  assert.deepEqual(
    session.messages.map((m) => [m.type, m.text]),
    [
      ["assistantStart", undefined],
      ["assistantChunk", "Hello"],
      ["assistantDone", undefined],
    ]
  );
  assert.equal(session.isAssistantOpen, false);
  assert.equal(session.hasHistory, true);
});

test("recording does not change the message that was posted", () => {
  const session = new ChatSession("s");
  const first = { type: "assistantChunk", text: "a" };
  session.record(first);
  session.record({ type: "assistantChunk", text: "b" });
  assert.equal(first.text, "a");
});

test("a turn keeps one todo card that later updates rewrite", () => {
  const session = new ChatSession("s");
  session.record({ type: "assistantStart" });
  session.record({ type: "todos", todos: session.updateTodos([{ id: "1", content: "one", status: "in_progress" }], false) });
  session.record({ type: "assistantChunk", text: "working" });
  session.record({ type: "todos", todos: session.updateTodos([{ id: "1", content: "one", status: "completed" }], true) });

  const cards = session.messages.filter((m) => m.type === "todos");
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].todos, [{ id: "1", content: "one", status: "completed" }]);
  // The card stays where it first appeared.
  assert.equal(session.messages[1].type, "todos");

  session.record({ type: "assistantDone", stopReason: "end_turn" });
  session.record({ type: "assistantStart" });
  session.record({ type: "todos", todos: session.todos });
  assert.equal(session.messages.filter((m) => m.type === "todos").length, 2);
});

test("todo updates replace the list or merge by id", () => {
  const session = new ChatSession("s");
  session.updateTodos(
    [
      { id: "1", content: "one", status: "in_progress" },
      { id: "2", content: "two", status: "pending" },
    ],
    false
  );
  const merged = session.updateTodos(
    [
      { id: "1", content: "one", status: "completed" },
      { id: "3", content: "three", status: "pending" },
    ],
    true
  );
  assert.deepEqual(
    merged.map((t) => `${t.id}:${t.status}`),
    ["1:completed", "2:pending", "3:pending"]
  );
  assert.deepEqual(session.updateTodos([{ id: "9", content: "new", status: "pending" }], false).map((t) => t.id), ["9"]);
});

test("an answered card is not replayed", () => {
  const session = new ChatSession("s");
  session.record({ type: "permissionRequest", id: "1" });
  session.record({ type: "questionRequest", id: "2" });
  session.forget("permissionRequest", "1");
  assert.deepEqual(
    session.messages.map((m) => m.type),
    ["questionRequest"]
  );
});
