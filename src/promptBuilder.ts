import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { PromptContentBlock } from "./acpClient";
import { estimateFolderContext, loadSlashContent, readFolderContext } from "./contextCatalog";

export interface PromptImageAttachment {
  mimeType: string;
  data: string;
}

export interface PromptContextPreviewItem {
  id: string;
  token: string;
  replaceText: string;
  label: string;
  kind: "file" | "folder" | "command" | "missing";
  status: "ready" | "missing";
  detail: string;
  chars: number;
}

const AT_REF = /@([^\s@]+)/g;
const SLASH_PREFIX = /^\/([\w-]+)(?:\s+([\s\S]*))?$/;

async function readContextFile(filePath: string, maxChars = 40_000): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > maxChars * 2) {
      return undefined;
    }
    const content = await fs.readFile(filePath, "utf8");
    return content.length > maxChars ? `${content.slice(0, maxChars)}\n…(truncated)` : content;
  } catch {
    return undefined;
  }
}

function resolveAtPath(token: string, workspaceRoot: string): string {
  const normalized = token.replace(/\\/g, "/");
  if (nodePath.isAbsolute(normalized)) {
    return normalized;
  }
  return nodePath.join(workspaceRoot, normalized);
}

export async function buildPromptText(rawText: string, workspaceRoot: string): Promise<string> {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return trimmed;
  }

  let userText = trimmed;
  const sections: string[] = [];

  const slashMatch = trimmed.match(SLASH_PREFIX);
  if (slashMatch) {
    const slashBody = await loadSlashContent(slashMatch[1], workspaceRoot);
    if (slashBody) {
      sections.push(slashBody);
    }
    userText = slashMatch[2]?.trim() ?? "";
  }

  const refs = [...trimmed.matchAll(AT_REF)];
  const seen = new Set<string>();
  for (const match of refs) {
    const token = match[1];
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);

    const normalizedToken = token.replace(/\/$/, "");
    const resolved = resolveAtPath(normalizedToken, workspaceRoot);
    let content: string | undefined;

    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        content = await readFolderContext(resolved);
        if (content !== undefined) {
          sections.push(`--- Context: ${normalizedToken}/ ---\n${content}`);
        }
        continue;
      }
    } catch {
      // fall through to file read
    }

    content = await readContextFile(resolved);
    if (content !== undefined) {
      sections.push(`--- Context: ${token} ---\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  if (sections.length === 0) {
    return trimmed;
  }

  if (userText) {
    sections.push(`User request:\n${userText}`);
  }

  return sections.join("\n\n");
}

export async function buildPromptBlocks(
  rawText: string,
  workspaceRoot: string,
  images: PromptImageAttachment[] = []
): Promise<PromptContentBlock[]> {
  const trimmed = rawText.trim();
  const blocks: PromptContentBlock[] = [];

  if (trimmed) {
    blocks.push({ type: "text", text: await buildPromptText(trimmed, workspaceRoot) });
  }

  for (const image of images) {
    blocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
  }

  return blocks;
}

export async function getPromptContextPreview(
  rawText: string,
  workspaceRoot: string
): Promise<PromptContextPreviewItem[]> {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return [];
  }

  const items: PromptContextPreviewItem[] = [];
  const slashMatch = trimmed.match(SLASH_PREFIX);
  if (slashMatch) {
    const name = slashMatch[1];
    const slashBody = await loadSlashContent(name, workspaceRoot);
    items.push({
      id: `slash:${name}`,
      token: `/${name}`,
      replaceText: `/${name}`,
      label: `/${name}`,
      kind: slashBody ? "command" : "missing",
      status: slashBody ? "ready" : "missing",
      detail: slashBody ? "Command / Skill" : "見つかりません",
      chars: slashBody?.length ?? 0,
    });
  }

  const refs = [...trimmed.matchAll(AT_REF)];
  const seen = new Set<string>();
  for (const match of refs) {
    const token = match[1];
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);

    const normalizedToken = token.replace(/\/$/, "");
    const resolved = resolveAtPath(normalizedToken, workspaceRoot);
    const label = token;
    const replaceText = `@${token}`;

    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        const estimate = await estimateFolderContext(resolved);
        items.push({
          id: `folder:${normalizedToken}`,
          token: `@${token}`,
          replaceText,
          label,
          kind: "folder",
          status: "ready",
          detail: `${estimate.files} files`,
          chars: estimate.chars,
        });
        continue;
      }

      if (stat.isFile()) {
        items.push({
          id: `file:${normalizedToken}`,
          token: `@${token}`,
          replaceText,
          label,
          kind: "file",
          status: "ready",
          detail: nodePath.basename(normalizedToken),
          chars: Math.min(stat.size, 40_000),
        });
        continue;
      }
    } catch {
      // fall through to missing item
    }

    items.push({
      id: `missing:${normalizedToken}`,
      token: `@${token}`,
      replaceText,
      label,
      kind: "missing",
      status: "missing",
      detail: "見つかりません",
      chars: 0,
    });
  }

  return items;
}
