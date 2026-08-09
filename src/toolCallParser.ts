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

function buildPreview(
  oldText: string | null | undefined,
  newText: string | undefined
): { addedLines: number; removedLines: number; previewLines: DiffPreviewLine[] } {
  if (!newText) {
    return { addedLines: 0, removedLines: 0, previewLines: [] };
  }

  const newLines = newText.split("\n");
  if (!oldText) {
    const previewLines = newLines.slice(0, 14).map((text) => ({ type: "add" as const, text }));
    return { addedLines: newLines.length, removedLines: 0, previewLines };
  }

  const oldLines = oldText.split("\n");
  const previewLines: DiffPreviewLine[] = [];
  let addedLines = 0;
  let removedLines = 0;
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine === newLine) {
      continue;
    }

    if (oldLine !== undefined && newLine === undefined) {
      removedLines++;
      if (previewLines.length < 14) {
        previewLines.push({ type: "remove", text: oldLine });
      }
      continue;
    }

    if (newLine !== undefined) {
      addedLines++;
      if (previewLines.length < 14) {
        previewLines.push({ type: "add", text: newLine });
      }
    }
  }

  if (previewLines.length === 0) {
    newLines.slice(0, 10).forEach((text) => previewLines.push({ type: "add", text }));
    addedLines = newLines.length;
  }

  return { addedLines, removedLines, previewLines };
}

function extractDiff(content: unknown): { path?: string; oldText?: string | null; newText?: string } {
  if (!Array.isArray(content)) {
    return {};
  }

  for (const item of content) {
    const block = asRecord(item);
    if (!block) {
      continue;
    }

    if (block.type === "diff") {
      return {
        path: block.path as string | undefined,
        oldText: block.oldText as string | null | undefined,
        newText: block.newText as string | undefined,
      };
    }

    const nested = asRecord(block.content);
    if (nested?.type === "diff") {
      return {
        path: nested.path as string | undefined,
        oldText: nested.oldText as string | null | undefined,
        newText: nested.newText as string | undefined,
      };
    }
  }

  return {};
}

function normalizeStatus(status?: string, sessionUpdate?: string): string {
  if (status) {
    return status;
  }
  return sessionUpdate === "tool_call_update" ? "in_progress" : "pending";
}

function isEditLike(kind?: string, title?: string, path?: string): boolean {
  const blob = `${kind ?? ""} ${title ?? ""} ${path ?? ""}`.toLowerCase();
  return (
    kind === "edit" ||
    kind === "write" ||
    blob.includes("write") ||
    blob.includes("edit") ||
    blob.includes("create") ||
    blob.includes("patch") ||
    /\.(ts|tsx|js|jsx|css|json|md|bat|ps1|py|rs|go|html|vue|svelte)$/i.test(path ?? "")
  );
}

export function parseToolUpdate(update: Record<string, unknown>): ParsedToolUpdate | undefined {
  const sessionUpdate = update.sessionUpdate as string | undefined;
  if (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update") {
    return undefined;
  }

  const nested = asRecord(update.toolCall);
  const toolCallId = String(
    update.toolCallId ?? nested?.toolCallId ?? update.title ?? nested?.title ?? `tool-${Date.now()}`
  );
  const kind = (update.kind ?? nested?.kind) as string | undefined;
  const title = (update.title ?? nested?.title) as string | undefined;
  const status = normalizeStatus((update.status ?? nested?.status) as string | undefined, sessionUpdate);
  const locations = (update.locations ?? nested?.locations) as ToolLocation[] | undefined;
  const rawInput = asRecord(update.rawInput ?? nested?.rawInput);
  const diff = extractDiff(update.content ?? nested?.content);

  let filePath =
    diff.path ??
    locations?.[0]?.path ??
    (rawInput?.path as string | undefined) ??
    extractPathFromTitle(title);

  const newText = diff.newText ?? (rawInput?.content as string | undefined) ?? (rawInput?.newText as string | undefined);
  const oldText = diff.oldText ?? (rawInput?.oldText as string | null | undefined);

  const activityTitle = deriveActivityTitle(title, kind, rawInput, filePath);

  if (!filePath && !isEditLike(kind, title)) {
    return {
      toolCallId,
      kind,
      title,
      status,
      activityTitle,
    };
  }

  if (!filePath) {
    return {
      toolCallId,
      kind,
      title,
      status,
      activityTitle,
    };
  }

  if (!isEditLike(kind, title, filePath) && !newText && !oldText) {
    return {
      toolCallId,
      kind,
      title,
      status,
      activityTitle: activityTitle ?? path.basename(filePath),
    };
  }

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
