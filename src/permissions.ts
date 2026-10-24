// What a permission request is for. The tool kind decides when the agent sent
// one; guessing from file extensions in the title called "npm test -- a.ts" a
// file change. "Allow always" rules match on the result, so it must be stable.
export function permissionCategory(title: string, kind?: string): "change" | "command" | "read" | "other" {
  switch (kind) {
    case "edit":
    case "delete":
    case "move":
    case "write":
      return "change";
    case "execute":
      return "command";
    case "read":
    case "search":
    case "fetch":
      return "read";
  }

  if (/^\s*(write|edit|create|delete|patch)\b/i.test(title)) {
    return "change";
  }
  if (/^\s*(`|(run|exec|execute|shell|command)\b)/i.test(title)) {
    return "command";
  }
  if (/^\s*(read|glob|grep|search|find|list)\b/i.test(title)) {
    return "read";
  }
  return "other";
}
