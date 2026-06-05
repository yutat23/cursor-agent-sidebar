import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { PromptContentBlock } from "./acpClient";
import { loadSlashContent, readFolderContext } from "./contextCatalog";

export interface PromptImageAttachment {
  mimeType: string;
  data: string;
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
