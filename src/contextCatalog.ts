import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";

export type SuggestKind = "file" | "slash";

export interface SuggestItem {
  id: string;
  label: string;
  detail?: string;
  insertText: string;
  kind: "file" | "folder" | "command" | "skill";
}

const TEXT_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".css",
  ".html",
  ".yaml",
  ".yml",
  ".xml",
  ".svg",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".cpp",
  ".h",
  ".sql",
  ".sh",
  ".ps1",
  ".bat",
  ".toml",
  ".ini",
  ".env",
  ".txt",
]);

function shouldIgnoreRelativePath(rel: string): boolean {
  return rel.split("/").some((part) => IGNORE_DIRS.has(part));
}

function matchesQuery(rel: string, query: string): boolean {
  if (!query) {
    return true;
  }
  return rel.toLowerCase().includes(query);
}

function rankMatch(rel: string, query: string): number {
  if (!query) {
    return 0;
  }
  const lower = rel.toLowerCase();
  const q = query.toLowerCase();
  if (lower === q || lower === `${q}/`) {
    return 0;
  }
  if (lower.startsWith(q)) {
    return 1;
  }
  const base = nodePath.posix.basename(lower.replace(/\/$/, ""));
  if (base.startsWith(q)) {
    return 2;
  }
  return 3;
}

function pathDepth(label: string): number {
  return label.replace(/\/$/, "").split("/").length - 1;
}

function maxWalkDepth(query: string): number {
  return query ? 8 : 2;
}

function shouldRecurseIntoDir(
  query: string,
  rel: string,
  entryName: string,
  depth: number
): boolean {
  if (depth >= maxWalkDepth(query)) {
    return false;
  }
  if (!query) {
    return true;
  }
  const lastSegment = query.split("/").pop() ?? query;
  return (
    rel.toLowerCase().includes(query) ||
    entryName.toLowerCase().includes(lastSegment) ||
    query.startsWith(`${rel}/`)
  );
}

function compareSuggestItems(a: SuggestItem, b: SuggestItem, query: string): number {
  const rankDiff = rankMatch(a.label, query) - rankMatch(b.label, query);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  const depthDiff = pathDepth(a.label) - pathDepth(b.label);
  if (depthDiff !== 0) {
    return depthDiff;
  }
  return a.label.localeCompare(b.label);
}

async function collectFolderItems(
  workspaceRoot: string,
  query: string,
  limit: number
): Promise<SuggestItem[]> {
  const items: SuggestItem[] = [];
  const seen = new Set<string>();

  async function walk(absDir: string, relDir: string, depth: number): Promise<void> {
    if (items.length >= limit || depth > maxWalkDepth(query)) {
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) {
        continue;
      }

      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (shouldIgnoreRelativePath(rel)) {
        continue;
      }

      const relWithSlash = `${rel}/`;
      if (matchesQuery(rel, query) || matchesQuery(relWithSlash, query)) {
        if (!seen.has(rel)) {
          seen.add(rel);
          items.push({
            id: `folder:${rel}`,
            label: relWithSlash,
            detail: "Folder",
            insertText: relWithSlash,
            kind: "folder",
          });
        }
      }

      if (shouldRecurseIntoDir(query, rel, entry.name, depth)) {
        await walk(nodePath.join(absDir, entry.name), rel, depth + 1);
      }
    }
  }

  await walk(workspaceRoot, "", 0);
  return items;
}

async function collectFileItems(
  workspaceRoot: string,
  query: string,
  limit: number
): Promise<SuggestItem[]> {
  const items: SuggestItem[] = [];
  const seen = new Set<string>();

  async function walk(absDir: string, relDir: string, depth: number): Promise<void> {
    if (items.length >= limit || depth > maxWalkDepth(query)) {
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (shouldIgnoreRelativePath(rel)) {
        continue;
      }

      if (entry.isFile()) {
        if (!query || matchesQuery(rel, query)) {
          if (!seen.has(rel)) {
            seen.add(rel);
            items.push({
              id: `file:${rel}`,
              label: rel,
              detail: nodePath.basename(rel),
              insertText: rel,
              kind: "file",
            });
          }
        }
        continue;
      }

      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) {
        continue;
      }

      if (shouldRecurseIntoDir(query, rel, entry.name, depth)) {
        await walk(nodePath.join(absDir, entry.name), rel, depth + 1);
      }
    }
  }

  await walk(workspaceRoot, "", 0);
  return items;
}

interface SlashEntry {
  name: string;
  description: string;
  kind: "command" | "skill";
  filePath: string;
  scope: "workspace" | "user";
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  "coverage",
  ".cursor",
]);

let slashCache: SlashEntry[] | undefined;
let slashCacheAt = 0;
const SLASH_CACHE_MS = 30_000;

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }

  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const description = block
    .match(/^description:\s*(?:>\s*|-\s*)?([\s\S]*?)(?:\n[A-Za-z_][\w-]*:|\n---|$)/m)?.[1]
    ?.replace(/\s+/g, " ")
    .trim()
    .replace(/^['"]|['"]$/g, "");

  return { name, description };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectSlashEntries(root: string, scope: "workspace" | "user"): Promise<SlashEntry[]> {
  const entries: SlashEntry[] = [];

  const commandDir = nodePath.join(root, ".cursor", "commands");
  if (await fileExists(commandDir)) {
    const files = await fs.readdir(commandDir);
    for (const file of files) {
      if (!file.endsWith(".md")) {
        continue;
      }
      const filePath = nodePath.join(commandDir, file);
      const content = await fs.readFile(filePath, "utf8");
      const fm = parseFrontmatter(content);
      const name = fm.name ?? nodePath.basename(file, ".md");
      entries.push({
        name,
        description: fm.description ?? "Slash command",
        kind: "command",
        filePath,
        scope,
      });
    }
  }

  const skillRoots = [
    nodePath.join(root, ".cursor", "skills"),
    nodePath.join(root, ".cursor", "skills-cursor"),
    nodePath.join(root, ".codex", "skills"),
  ];

  for (const skillRoot of skillRoots) {
    if (!(await fileExists(skillRoot))) {
      continue;
    }

    const dirs = await fs.readdir(skillRoot, { withFileTypes: true });
    for (const dirent of dirs) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const filePath = nodePath.join(skillRoot, dirent.name, "SKILL.md");
      if (!(await fileExists(filePath))) {
        continue;
      }
      const content = await fs.readFile(filePath, "utf8");
      const fm = parseFrontmatter(content);
      const name = fm.name ?? dirent.name;
      entries.push({
        name,
        description: fm.description ?? "Agent skill",
        kind: "skill",
        filePath,
        scope,
      });
    }
  }

  return entries;
}

export async function getSlashEntries(workspaceRoot: string): Promise<SlashEntry[]> {
  const now = Date.now();
  if (slashCache && now - slashCacheAt < SLASH_CACHE_MS) {
    return slashCache;
  }

  const home = os.homedir();
  const roots: Array<{ root: string; scope: "workspace" | "user" }> = [
    { root: workspaceRoot, scope: "workspace" },
    { root: home, scope: "user" },
  ];

  const merged = new Map<string, SlashEntry>();
  for (const { root, scope } of roots) {
    const entries = await collectSlashEntries(root, scope);
    for (const entry of entries) {
      const key = entry.name.toLowerCase();
      if (!merged.has(key)) {
        merged.set(key, entry);
      }
    }
  }

  slashCache = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  slashCacheAt = now;
  return slashCache;
}

export async function searchSlashItems(query: string, workspaceRoot: string): Promise<SuggestItem[]> {
  const q = query.trim().toLowerCase();
  const entries = await getSlashEntries(workspaceRoot);

  return entries
    .filter((entry) => {
      if (!q) {
        return true;
      }
      return (
        entry.name.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q)
      );
    })
    .slice(0, 20)
    .map((entry) => ({
      id: `${entry.kind}:${entry.name}`,
      label: `/${entry.name}`,
      detail: `${entry.kind === "skill" ? "Skill" : "Command"} · ${entry.scope} — ${entry.description}`,
      insertText: entry.name,
      kind: entry.kind,
    }));
}

export async function searchFileItems(query: string, workspaceRoot: string): Promise<SuggestItem[]> {
  const q = query.trim().toLowerCase().replace(/\\/g, "/");
  if (!workspaceRoot) {
    return [];
  }

  const [folderItems, fileItems] = await Promise.all([
    collectFolderItems(workspaceRoot, q, 30),
    collectFileItems(workspaceRoot, q, 80),
  ]);

  const folderPaths = new Set<string>();
  for (const item of folderItems) {
    folderPaths.add(item.insertText.replace(/\/$/, ""));
  }

  for (const item of fileItems) {
    const rel = item.insertText;
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!shouldIgnoreRelativePath(dir) && matchesQuery(dir, q) && !folderPaths.has(dir)) {
        folderPaths.add(dir);
        folderItems.push({
          id: `folder:${dir}`,
          label: `${dir}/`,
          detail: "Folder",
          insertText: `${dir}/`,
          kind: "folder",
        });
      }
    }
  }

  const folders = [...new Map(folderItems.map((item) => [item.insertText, item])).values()];
  const merged = [...folders, ...fileItems];
  merged.sort((a, b) => compareSuggestItems(a, b, q));

  return merged.slice(0, 20);
}

export async function readFolderContext(
  folderPath: string,
  maxFiles = 20,
  maxCharsPerFile = 8_000
): Promise<string | undefined> {
  try {
    const stat = await fs.stat(folderPath);
    if (!stat.isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(vscode.Uri.file(folderPath), "**/*"),
    "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**}",
    maxFiles * 3
  );

  const blocks: string[] = [];
  for (const uri of uris) {
    if (blocks.length >= maxFiles) {
      break;
    }

    const ext = nodePath.extname(uri.fsPath).toLowerCase();
    if (!TEXT_FILE_EXTENSIONS.has(ext)) {
      continue;
    }

    try {
      const stat = await fs.stat(uri.fsPath);
      if (!stat.isFile() || stat.size > maxCharsPerFile * 2) {
        continue;
      }
      let content = await fs.readFile(uri.fsPath, "utf8");
      if (content.length > maxCharsPerFile) {
        content = `${content.slice(0, maxCharsPerFile)}\n…(truncated)`;
      }
      const rel = nodePath.relative(folderPath, uri.fsPath).replace(/\\/g, "/");
      blocks.push(`### ${rel}\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      continue;
    }
  }

  if (blocks.length === 0) {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const listing = entries
      .filter((entry) => !IGNORE_DIRS.has(entry.name))
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .join("\n");
    return listing || "(empty folder)";
  }

  return blocks.join("\n\n");
}

export async function estimateFolderContext(
  folderPath: string,
  maxFiles = 20,
  maxCharsPerFile = 8_000
): Promise<{ files: number; chars: number }> {
  try {
    const stat = await fs.stat(folderPath);
    if (!stat.isDirectory()) {
      return { files: 0, chars: 0 };
    }
  } catch {
    return { files: 0, chars: 0 };
  }

  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(vscode.Uri.file(folderPath), "**/*"),
    "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**}",
    maxFiles * 3
  );

  let files = 0;
  let chars = 0;
  for (const uri of uris) {
    if (files >= maxFiles) {
      break;
    }

    const ext = nodePath.extname(uri.fsPath).toLowerCase();
    if (!TEXT_FILE_EXTENSIONS.has(ext)) {
      continue;
    }

    try {
      const stat = await fs.stat(uri.fsPath);
      if (!stat.isFile() || stat.size > maxCharsPerFile * 2) {
        continue;
      }
      files++;
      chars += Math.min(stat.size, maxCharsPerFile);
    } catch {
      continue;
    }
  }

  return { files, chars };
}

export async function loadSlashContent(name: string, workspaceRoot: string): Promise<string | undefined> {
  const entries = await getSlashEntries(workspaceRoot);
  const entry = entries.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!entry) {
    return undefined;
  }

  const raw = await fs.readFile(entry.filePath, "utf8");
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const header =
    entry.kind === "skill"
      ? `Use the following skill instructions (${entry.name}):\n\n`
      : `Use the following command prompt (${entry.name}):\n\n`;

  return `${header}${body}`;
}

export function invalidateSlashCache(): void {
  slashCache = undefined;
  slashCacheAt = 0;
}
