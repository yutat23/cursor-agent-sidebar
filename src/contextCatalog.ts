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

async function collectFolderItems(
  workspaceRoot: string,
  query: string,
  limit: number
): Promise<SuggestItem[]> {
  const items: SuggestItem[] = [];
  const seen = new Set<string>();

  async function walk(absDir: string, relDir: string, depth: number): Promise<void> {
    if (items.length >= limit || depth > 8) {
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

      const lastSegment = query.split("/").pop() ?? query;
      const shouldRecurse =
        !query ||
        rel.toLowerCase().includes(query) ||
        entry.name.toLowerCase().includes(lastSegment) ||
        query.startsWith(`${rel}/`);

      if (shouldRecurse) {
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

  const pattern =
    q.length > 0
      ? `**/*${q.split("/").pop() ?? q}*`
      : "**/*";

  const [uris, folderItems] = await Promise.all([
    vscode.workspace.findFiles(
      pattern,
      "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**}",
      80
    ),
    collectFolderItems(workspaceRoot, q, 30),
  ]);

  const folderPaths = new Set<string>();
  const fileItems: SuggestItem[] = [];

  for (const item of folderItems) {
    folderPaths.add(item.insertText.replace(/\/$/, ""));
  }

  for (const uri of uris) {
    const fullPath = uri.fsPath;
    const rel = nodePath.relative(workspaceRoot, fullPath).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || shouldIgnoreRelativePath(rel)) {
      continue;
    }
    if (q && !matchesQuery(rel, q)) {
      continue;
    }

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

    fileItems.push({
      id: `file:${rel}`,
      label: rel,
      detail: nodePath.basename(rel),
      insertText: rel,
      kind: "file",
    });
  }

  const folders = [...new Map(folderItems.map((item) => [item.insertText, item])).values()];
  const merged = [...folders, ...fileItems];
  merged.sort((a, b) => {
    const rankDiff = rankMatch(a.label, q) - rankMatch(b.label, q);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    if (a.kind !== b.kind) {
      return a.kind === "folder" ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });

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
