import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const API_BASE = "https://api2.cursor.sh/aiserver.v1.DashboardService";
const USAGE_API_URL = `${API_BASE}/GetCurrentPeriodUsage`;
const PLAN_INFO_API_URL = `${API_BASE}/GetPlanInfo`;
const KEYCHAIN_SERVICE = "cursor-access-token";
const KEYCHAIN_ACCOUNT = "cursor-user";
/** Cursor CLI credential domain; Windows title-cases this to `Cursor`. */
const CREDENTIAL_DOMAIN = "cursor";

export interface CursorUsageSnapshot {
  fetchedAt: string;
  displayMessage?: string;
  planName?: string;
  billingCycleStart?: string;
  billingCycleEnd?: string;
  /** Matching Cursor CLI TUI: Included / Auto / API percentages (0-100). */
  included?: {
    totalPercentUsed: number;
    autoPercentUsed: number;
    apiPercentUsed: number;
  };
  onDemand?: {
    kind: "fixed" | "disabled" | "unlimited";
    usedCents: number;
    limitCents?: number;
    remainingCents?: number;
  };
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export async function fetchCursorUsage(): Promise<CursorUsageSnapshot> {
  const token = await resolveAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
  };

  const [usageResponse, planResponse] = await Promise.all([
    fetch(USAGE_API_URL, { method: "POST", headers, body: "{}" }),
    fetch(PLAN_INFO_API_URL, { method: "POST", headers, body: "{}" }).catch(() => undefined),
  ]);

  if (usageResponse.status === 401 || usageResponse.status === 403) {
    throw new UsageError("Cursor authentication expired. Run `agent login` and try again.");
  }

  if (!usageResponse.ok) {
    throw new UsageError(`Usage API failed (${usageResponse.status})`);
  }

  const raw = (await usageResponse.json()) as Record<string, unknown>;
  let planName: string | undefined;
  if (planResponse?.ok) {
    try {
      const planRaw = (await planResponse.json()) as Record<string, unknown>;
      const planInfo = asRecord(planRaw.planInfo);
      if (typeof planInfo?.planName === "string" && planInfo.planName.trim()) {
        planName = planInfo.planName.trim();
      }
    } catch {
      // Plan name is optional enrichment.
    }
  }

  return normalizeUsage(raw, planName);
}

async function resolveAccessToken(): Promise<string> {
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  try {
    if (process.platform === "darwin") {
      return await readMacOsKeychainToken();
    }
    if (process.platform === "linux") {
      try {
        return await readAuthFileToken();
      } catch {
        return await readLinuxSecretToken();
      }
    }
    if (process.platform === "win32") {
      return await readAuthFileToken();
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Could not read Cursor CLI credentials: ${detail}`);
  }

  throw new UsageError("Unsupported platform for Cursor CLI credential lookup.");
}

/**
 * Cursor CLI stores login tokens in auth.json on Windows/Linux
 * (keychain/secret-service only on macOS by default).
 * Paths mirror cli-credentials getAuthFilePath():
 * - win32: %APPDATA%\Cursor\auth.json
 * - linux: $XDG_CONFIG_HOME/cursor/auth.json or ~/.config/cursor/auth.json
 * - darwin file fallback: ~/.cursor/auth.json
 */
async function readAuthFileToken(): Promise<string> {
  const authPath = resolveAuthFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(authPath, "utf8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (code === "ENOENT") {
      throw new Error(`auth file not found at ${authPath}; run \`agent login\``);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid auth file at ${authPath}`);
  }

  const accessToken =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).accessToken
      : undefined;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error(`accessToken missing in ${authPath}; run \`agent login\``);
  }
  return accessToken.trim();
}

function resolveAuthFilePath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const folder = CREDENTIAL_DOMAIN.charAt(0).toUpperCase() + CREDENTIAL_DOMAIN.slice(1).toLowerCase();
    return path.join(appData, folder, "auth.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), `.${CREDENTIAL_DOMAIN}`, "auth.json");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, CREDENTIAL_DOMAIN, "auth.json");
}

async function readMacOsKeychainToken(): Promise<string> {
  const { stdout } = await execFileAsync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
    { timeout: 5_000, maxBuffer: 1024 * 1024 }
  );
  const token = stdout.trim();
  if (!token) {
    throw new Error("empty keychain token");
  }
  return token;
}

async function readLinuxSecretToken(): Promise<string> {
  const { stdout } = await execFileAsync(
    "secret-tool",
    ["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
    { timeout: 5_000, maxBuffer: 1024 * 1024 }
  );
  const token = stdout.trim();
  if (!token) {
    throw new Error("empty secret-tool token");
  }
  return token;
}

function normalizeUsage(raw: Record<string, unknown>, planName?: string): CursorUsageSnapshot {
  const planUsage = asRecord(raw.planUsage);
  const spendLimitUsage = asRecord(raw.spendLimitUsage);

  const snapshot: CursorUsageSnapshot = {
    fetchedAt: new Date().toISOString(),
    displayMessage: typeof raw.displayMessage === "string" ? raw.displayMessage : undefined,
    planName,
    billingCycleStart: normalizeTimestamp(raw.billingCycleStart),
    billingCycleEnd: normalizeTimestamp(raw.billingCycleEnd),
  };

  if (planUsage) {
    const usedCents = toNumber(planUsage.includedSpend ?? planUsage.totalSpend) ?? 0;
    const limitCents = toNumber(planUsage.limit) ?? 0;
    const totalPercentUsed = clampPercent(
      toNumber(planUsage.totalPercentUsed) ?? (limitCents > 0 ? (usedCents / limitCents) * 100 : 0)
    );
    snapshot.included = {
      totalPercentUsed,
      autoPercentUsed: clampPercent(toNumber(planUsage.autoPercentUsed) ?? 0),
      apiPercentUsed: clampPercent(toNumber(planUsage.apiPercentUsed) ?? 0),
    };
  }

  if (spendLimitUsage) {
    const usedCents = toNumber(spendLimitUsage.individualUsed) ?? 0;
    const limitCents = toNumber(spendLimitUsage.individualLimit);
    const remainingCents = toNumber(spendLimitUsage.individualRemaining);

    if (limitCents !== undefined && limitCents > 0) {
      snapshot.onDemand = {
        kind: "fixed",
        usedCents,
        limitCents,
        remainingCents: remainingCents ?? Math.max(limitCents - usedCents, 0),
      };
    } else if (limitCents === 0) {
      snapshot.onDemand = { kind: "disabled", usedCents };
    } else {
      snapshot.onDemand = { kind: "unlimited", usedCents };
    }
  }

  if (!snapshot.included && !snapshot.onDemand && !snapshot.displayMessage) {
    throw new UsageError("Usage response did not include recognizable plan data.");
  }

  return snapshot;
}

/** Same display rounding as Cursor CLI TUI: values in (0, 1) become 1%. */
export function formatUsagePercent(percent: number): string {
  const clamped = clampPercent(percent);
  const display = clamped > 0 && clamped < 1 ? 1 : Math.round(clamped);
  return `${display}%`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && /^\d+$/.test(value.trim())) {
      return new Date(asNumber).toISOString();
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return undefined;
}
