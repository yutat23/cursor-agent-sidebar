import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SessionHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

interface SessionMeta {
  latestRootBlobId?: string;
}

interface StoredMessage {
  role?: string;
  content?: unknown;
}

const SQLITE_MAX_BUFFER = 100 * 1024 * 1024;

function readVarint(buf: Buffer, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  return [value, pos];
}

function parseFields(buf: Buffer): Array<{ wire: number; data: Buffer | number }> {
  const fields: Array<{ wire: number; data: Buffer | number }> = [];
  let pos = 0;

  while (pos < buf.length) {
    const [tag, nextPos] = readVarint(buf, pos);
    pos = nextPos;
    const wire = tag & 7;

    if (wire === 2) {
      const [length, dataStart] = readVarint(buf, pos);
      pos = dataStart;
      fields.push({ wire, data: buf.slice(pos, pos + length) });
      pos += length;
      continue;
    }

    if (wire === 0) {
      const [value, afterValue] = readVarint(buf, pos);
      pos = afterValue;
      fields.push({ wire, data: value });
      continue;
    }

    break;
  }

  return fields;
}

function collectBlobIds(buf: Buffer, out: string[]): void {
  for (const field of parseFields(buf)) {
    if (field.wire !== 2 || !Buffer.isBuffer(field.data)) {
      continue;
    }

    if (field.data.length === 32) {
      out.push(field.data.toString("hex"));
      continue;
    }

    collectBlobIds(field.data, out);
  }
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type?: string; text?: string } => typeof block === "object" && block !== null)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text!)
      .join("");
  }

  return "";
}

function extractUserVisibleText(content: string): string | undefined {
  const queryMatch = content.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (queryMatch) {
    const text = queryMatch[1]?.trim();
    return text || undefined;
  }

  const trimmed = content.trim();
  if (trimmed && !trimmed.startsWith("<")) {
    return trimmed;
  }

  return undefined;
}

function parseStoredMessage(data: Buffer): SessionHistoryMessage | undefined {
  if (data.length === 0 || data[0] !== 0x7b) {
    return undefined;
  }

  let parsed: StoredMessage;
  try {
    parsed = JSON.parse(data.toString("utf8")) as StoredMessage;
  } catch {
    return undefined;
  }

  if (parsed.role === "user") {
    const text = extractUserVisibleText(extractMessageText(parsed.content));
    return text ? { role: "user", text } : undefined;
  }

  if (parsed.role === "assistant") {
    const text = extractMessageText(parsed.content).trim();
    return text ? { role: "assistant", text } : undefined;
  }

  return undefined;
}

async function querySqlite(dbPath: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync("sqlite3", ["-batch", "-noheader", dbPath, sql], {
    maxBuffer: SQLITE_MAX_BUFFER,
  });
  return stdout;
}

function getSessionStorePath(sessionId: string): string | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return undefined;
  }

  return nodePath.join(os.homedir(), ".cursor", "acp-sessions", sessionId, "store.db");
}

async function readSessionMeta(dbPath: string): Promise<SessionMeta | undefined> {
  const hex = (await querySqlite(dbPath, "SELECT value FROM meta WHERE key='0';")).trim();
  if (!hex) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.from(hex, "hex").toString("utf8")) as SessionMeta;
  } catch {
    return undefined;
  }
}

async function readBlobMap(dbPath: string): Promise<Map<string, Buffer>> {
  const rows = (await querySqlite(
    dbPath,
    "SELECT id || '|' || hex(data) FROM blobs WHERE hex(substr(data, 1, 2)) = '7B22';"
  ))
    .trim()
    .split("\n")
    .filter(Boolean);

  const blobs = new Map<string, Buffer>();
  for (const row of rows) {
    const separator = row.indexOf("|");
    if (separator !== 64) {
      continue;
    }

    const id = row.slice(0, separator);
    const hex = row.slice(separator + 1);
    if (!/^[0-9a-f]{64}$/i.test(id) || !hex) {
      continue;
    }

    blobs.set(id, Buffer.from(hex, "hex"));
  }

  return blobs;
}

async function readRootBlob(dbPath: string, rootBlobId: string): Promise<Buffer | undefined> {
  if (!/^[0-9a-f]{64}$/i.test(rootBlobId)) {
    return undefined;
  }

  const hex = (await querySqlite(dbPath, `SELECT hex(data) FROM blobs WHERE id='${rootBlobId}';`)).trim();
  if (!hex) {
    return undefined;
  }

  return Buffer.from(hex, "hex");
}

export async function loadSessionHistory(sessionId: string): Promise<SessionHistoryMessage[]> {
  const dbPath = getSessionStorePath(sessionId);
  if (!dbPath) {
    return [];
  }

  try {
    await fs.access(dbPath);
  } catch {
    return [];
  }

  try {
    const meta = await readSessionMeta(dbPath);
    const rootBlobId = meta?.latestRootBlobId;
    if (!rootBlobId) {
      return [];
    }

    const [rootBlob, blobMap] = await Promise.all([readRootBlob(dbPath, rootBlobId), readBlobMap(dbPath)]);
    if (!rootBlob) {
      return [];
    }

    blobMap.set(rootBlobId, rootBlob);

    const orderedIds: string[] = [];
    collectBlobIds(rootBlob, orderedIds);

    const messages: SessionHistoryMessage[] = [];
    const seen = new Set<string>();

    for (const blobId of orderedIds) {
      if (seen.has(blobId)) {
        continue;
      }
      seen.add(blobId);

      const blob = blobMap.get(blobId);
      if (!blob) {
        continue;
      }

      const message = parseStoredMessage(blob);
      if (message) {
        messages.push(message);
      }
    }

    return messages;
  } catch {
    return [];
  }
}
