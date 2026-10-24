import * as assert from "node:assert/strict";
import { test } from "node:test";
import { permissionCategory } from "../permissions";

test("the tool kind decides the category", () => {
  assert.equal(permissionCategory("npm test -- a.ts", "execute"), "command");
  assert.equal(permissionCategory("Read README.md", "read"), "read");
  assert.equal(permissionCategory("Edit File", "edit"), "change");
  assert.equal(permissionCategory("Remove old.ts", "delete"), "change");
});

test("file extensions in the title do not make a file change", () => {
  assert.equal(permissionCategory("npm test -- a.ts"), "other");
  assert.equal(permissionCategory("`./build.sh --watch`"), "command");
});

test("without a kind, the first word of the title decides", () => {
  assert.equal(permissionCategory("Write src/a.ts"), "change");
  assert.equal(permissionCategory("Run npm install"), "command");
  assert.equal(permissionCategory("Grep TODO"), "read");
  assert.equal(permissionCategory("Fetch https://example.com"), "other");
});
