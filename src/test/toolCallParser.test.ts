import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseToolUpdate } from "../toolCallParser";

const WS = "/workspace/";

function diffUpdate(id: string, path: string, oldText: string | null, newText: string): Record<string, unknown> {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    status: "completed",
    content: [{ type: "diff", path, oldText, newText }],
  };
}

test("a read of a .md or .json file is activity, not a file edit", () => {
  const kinds = new Map<string, string>();
  for (const file of ["README.md", "package.json", "src/createUser.ts"]) {
    const parsed = parseToolUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: file,
        title: `Read ${WS}${file}`,
        kind: "read",
        rawInput: { path: WS + file },
        locations: [{ path: WS + file }],
      },
      kinds
    );
    assert.equal(parsed?.fileEdit, undefined, file);
    assert.equal(parsed?.activityTitle, `Read ${WS}${file}`);
  }
});

test("the kind of the first update decides for later updates that omit it", () => {
  const kinds = new Map<string, string>();
  parseToolUpdate({ sessionUpdate: "tool_call", toolCallId: "e1", title: "Edit File", kind: "edit", rawInput: {} }, kinds);
  const located = parseToolUpdate(
    { sessionUpdate: "tool_call_update", toolCallId: "e1", title: `Edit \`${WS}README.md\``, rawInput: { path: `${WS}README.md` } },
    kinds
  );
  assert.equal(located?.fileEdit?.fileName, "README.md");

  parseToolUpdate({ sessionUpdate: "tool_call", toolCallId: "r1", title: `Read ${WS}a.md`, kind: "read", rawInput: { path: `${WS}a.md` } }, kinds);
  const readDone = parseToolUpdate({ sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed" }, kinds);
  assert.equal(readDone?.fileEdit, undefined);
  // A remembered kind must not overwrite the row's title.
  assert.equal(readDone?.activityTitle, undefined);
});

test("without a kind, only the title's first word marks a file change", () => {
  const kinds = new Map<string, string>();
  const write = parseToolUpdate({ sessionUpdate: "tool_call", toolCallId: "w", title: `Write "${WS}a.ts"` }, kinds);
  assert.equal(write?.fileEdit?.fileName, "a.ts");
  const other = parseToolUpdate({ sessionUpdate: "tool_call", toolCallId: "o", title: `Inspect "${WS}a.ts"` }, kinds);
  assert.equal(other?.fileEdit, undefined);
});

test("Cursor's new-file diff is a new file with no previous text", () => {
  const parsed = parseToolUpdate(diffUpdate("n1", `${WS}notes.md`, "-- /dev/null", `++ b/${WS}notes.md\nnote`), new Map());
  assert.equal(parsed?.fileEdit?.previousText, null);
  assert.equal(parsed?.fileEdit?.nextText, "note");
  assert.deepEqual(parsed?.fileEdit?.previewLines, [{ type: "add", text: "note" }]);
});

test("changed lines come from a real line diff", () => {
  const cases: Array<[string, string, string, number, number]> = [
    ["append one line", "a\nb\n", "a\nb\nc\n", 1, 0],
    ["insert at the top", "a\nb\nc\n", "x\na\nb\nc\n", 1, 0],
    ["change one line", "a\nb\nc\n", "a\nB\nc\n", 1, 1],
    ["delete one line", "a\nb\nc\n", "a\nc\n", 0, 1],
  ];
  for (const [label, oldText, newText, added, removed] of cases) {
    const edit = parseToolUpdate(diffUpdate(label, `${WS}a.ts`, oldText, newText), new Map())?.fileEdit;
    assert.equal(edit?.addedLines, added, label);
    assert.equal(edit?.removedLines, removed, label);
  }

  const changed = parseToolUpdate(diffUpdate("c", `${WS}a.ts`, "a\nb\nc\n", "a\nB\nc\n"), new Map())?.fileEdit;
  assert.deepEqual(changed?.previewLines, [
    { type: "remove", text: "b" },
    { type: "add", text: "B" },
  ]);
});

test("a huge rewrite is reported as replaced without diffing every cell", () => {
  const oldText = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  const newText = Array.from({ length: 3000 }, (_, i) => `row ${i}`).join("\n");
  const edit = parseToolUpdate(diffUpdate("big", `${WS}a.ts`, oldText, newText), new Map())?.fileEdit;
  assert.equal(edit?.addedLines, 3000);
  assert.equal(edit?.removedLines, 3000);
  assert.equal(edit?.previewLines.length, 14);
});
