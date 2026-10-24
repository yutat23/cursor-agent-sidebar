import * as path from "node:path";

export interface DiffPreviewLine {
  type: "add" | "remove" | "context";
  text: string;
}

export interface FileEditCardData {
  id: string;
  path: string;
  fileName: string;
  language: string;
  icon: string;
  addedLines: number;
  removedLines: number;
  status: string;
  previewLines: DiffPreviewLine[];
  line?: number;
  previousText?: string | null;
  nextText?: string;
}

export interface ParsedToolUpdate {
  toolCallId: string;
  kind?: string;
  title?: string;
  status?: string;
  fileEdit?: FileEditCardData;
  activityTitle?: string;
}

const LANGUAGE_ICONS: Record<string, string> = {
  ts: "TS",
  tsx: "TS",
  js: "JS",
  jsx: "JS",
  css: "#",
  scss: "#",
  html: "<>",
  json: "{}",
  md: "Md",
  bat: ">_",
  cmd: ">_",
  ps1: "Ps",
  py: "Py",
  rs: "Rs",
  go: "Go",
};

interface ToolLocation {
  path?: string;
  line?: number;
}

interface ContentBlock {
  type?: string;
  path?: string;
  oldText?: string | null;
  newText?: string;
  content?: { type?: string; text?: string };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function extractPathFromTitle(title?: string): string | undefined {
  if (!title) {
    return undefined;
  }
  const quoted = title.match(/"([^"]+)"/);
  if (quoted) {
    return quoted[1];
  }
  if (/^[A-Za-z]:\\/.test(title) || title.startsWith("/")) {
    return title;
  }
  return undefined;
}

function getLanguageInfo(filePath: string): { language: string; icon: string } {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return {
    language: ext || "txt",
    icon: LANGUAGE_ICONS[ext] ?? (ext.toUpperCase().slice(0, 2) || "📄"),
  };
}

const PREVIEW_LIMIT = 14;
// Above this many cells the line diff would cost too much; the changed middle
// is then reported as replaced wholesale.
const MAX_DIFF_CELLS = 2_000_000;

/** Changed lines between two texts, in order, from a longest-common-subsequence diff. */
function diffLines(oldLines: string[], newLines: string[]): DiffPreviewLine[] {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const a = oldLines.slice(start, oldEnd);
  const b = newLines.slice(start, newEnd);
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [
      ...a.map((text) => ({ type: "remove" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ];
  }

  // lcs[i * width + j]: common subsequence length of a[i..] and b[j..].
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const changes: DiffPreviewLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      changes.push({ type: "remove", text: a[i++] });
    } else {
      changes.push({ type: "add", text: b[j++] });
    }
  }
  return changes;
}

function buildPreview(
  oldText: string | null | undefined,
  newText: string | undefined
): { addedLines: number; removedLines: number; previewLines: DiffPreviewLine[] } {
  if (!newText) {
    return { addedLines: 0, removedLines: 0, previewLines: [] };
  }

  const newLines = newText.split("\n");
  if (!oldText) {
    const previewLines = newLines.slice(0, PREVIEW_LIMIT).map((text) => ({ type: "add" as const, text }));
    return { addedLines: newLines.length, removedLines: 0, previewLines };
  }

  const changes = diffLines(oldText.split("\n"), newLines);
  const addedLines = changes.filter((line) => line.type === "add").length;
  const removedLines = changes.length - addedLines;
  const previewLines = changes.slice(0, PREVIEW_LIMIT);

  if (previewLines.length === 0) {
    newLines.slice(0, 10).forEach((text) => previewLines.push({ type: "add", text }));
    return { addedLines: newLines.length, removedLines, previewLines };
  }

  return { addedLines, removedLines, previewLines };
}

interface DiffContent {
  path?: string;
  oldText?: string | null;
  newText?: string;
}

// The Cursor CLI reports a new file with unified-diff headers instead of an
// empty old text: oldText "-- /dev/null" and newText starting "++ b/<path>".
// Kept as is, reverting the file would write the header into it.
function normalizeDiff(diff: DiffContent): DiffContent {
  if (typeof diff.oldText === "string" && /^-{2,3} \/dev\/null$/.test(diff.oldText.trim())) {
    return {
      ...diff,
      oldText: null,
      newText: diff.newText?.replace(/^\+{2,3} [^\n]*\n?/, ""),
    };
  }
  return diff;
}

function extractDiff(content: unknown): DiffContent | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  for (const item of content) {
    const block = asRecord(item);
    if (!block) {
      continue;
    }

    const diff = block.type === "diff" ? block : asRecord(block.content);
    if (diff?.type === "diff") {
      return normalizeDiff({
        path: diff.path as string | undefined,
        oldText: diff.oldText as string | null | undefined,
        newText: diff.newText as string | undefined,
      });
    }
  }

  return undefined;
}

function normalizeStatus(status?: string, sessionUpdate?: string): string {
  if (status) {
    return status;
  }
  return sessionUpdate === "tool_call_update" ? "in_progress" : "pending";
}

const FILE_CHANGE_KINDS = new Set(["edit", "delete", "move", "write"]);

// Whether a tool changes files. The kind decides when the agent gave one; a
// read of README.md is still a read. Only without a kind does the title count.
function isFileChange(kind: string | undefined, title: string | undefined): boolean {
  if (kind) {
    return FILE_CHANGE_KINDS.has(kind);
  }
  return /^\s*(edit|write|create|patch)\b/i.test(title ?? "");
}

/**
 * Parses a tool_call / tool_call_update notification. Later updates for a call
 * usually omit its kind, so `knownKinds` remembers it by tool call id.
 */
export function parseToolUpdate(
  update: Record<string, unknown>,
  knownKinds: Map<string, string>
): ParsedToolUpdate | undefined {
  const sessionUpdate = update.sessionUpdate as string | undefined;
  if (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update") {
    return undefined;
  }

  const nested = asRecord(update.toolCall);
  const toolCallId = String(
    update.toolCallId ?? nested?.toolCallId ?? update.title ?? nested?.title ?? `tool-${Date.now()}`
  );
  const reportedKind = (update.kind ?? nested?.kind) as string | undefined;
  if (reportedKind) {
    knownKinds.set(toolCallId, reportedKind);
  }
  const kind = reportedKind ?? knownKinds.get(toolCallId);
  const title = (update.title ?? nested?.title) as string | undefined;
  const status = normalizeStatus((update.status ?? nested?.status) as string | undefined, sessionUpdate);
  const locations = (update.locations ?? nested?.locations) as ToolLocation[] | undefined;
  const rawInput = asRecord(update.rawInput ?? nested?.rawInput);
  const diff = extractDiff(update.content ?? nested?.content);

  const filePath =
    diff?.path ??
    locations?.[0]?.path ??
    (rawInput?.path as string | undefined) ??
    extractPathFromTitle(title);

  // Only a kind sent with this update names the row; a remembered one would
  // overwrite the title the row already has.
  const activityTitle = deriveActivityTitle(title, reportedKind, rawInput, filePath);

  // A diff is a file change whatever the kind says.
  if (!filePath || (!diff && !isFileChange(kind, title))) {
    return {
      toolCallId,
      kind,
      title,
      status,
      activityTitle: activityTitle ?? (filePath ? path.basename(filePath) : undefined),
    };
  }

  const newText = diff
    ? diff.newText
    : ((rawInput?.content as string | undefined) ?? (rawInput?.newText as string | undefined));
  const oldText = diff ? diff.oldText : (rawInput?.oldText as string | null | undefined);

  const { language, icon } = getLanguageInfo(filePath);
  const preview = buildPreview(oldText, newText);

  return {
    toolCallId,
    kind,
    title,
    status,
    fileEdit: {
      id: toolCallId,
      path: filePath,
      fileName: path.basename(filePath),
      language,
      icon,
      addedLines: preview.addedLines,
      removedLines: preview.removedLines,
      status,
      previewLines: preview.previewLines,
      line: locations?.[0]?.line,
      previousText: oldText,
      nextText: newText,
    },
    activityTitle: activityTitle ?? path.basename(filePath),
  };
}

function deriveActivityTitle(
  title: string | undefined,
  kind: string | undefined,
  rawInput: Record<string, unknown> | undefined,
  filePath?: string
): string | undefined {
  if (title?.trim()) {
    return title.trim();
  }

  const command = asString(rawInput?.command);
  if (command) {
    return `\`${command}\``;
  }

  const query = asString(rawInput?.query);
  if (query) {
    return `Search: "${query}"`;
  }

  const pattern = asString(rawInput?.pattern) ?? asString(rawInput?.globPattern);
  if (pattern) {
    return kind === "search" || kind === "grep" ? `grep "${pattern}"` : pattern;
  }

  const inputPath = filePath ?? asString(rawInput?.path);
  if (inputPath) {
    return path.basename(inputPath);
  }

  if (kind?.trim() && kind !== "other") {
    return kind.trim();
  }

  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
