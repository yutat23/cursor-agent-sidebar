import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const API_BASE = "https://api2.cursor.sh/aiserver.v1.DashboardService";
const USAGE_API_URL = `${API_BASE}/GetCurrentPeriodUsage`;
const PLAN_INFO_API_URL = `${API_BASE}/GetPlanInfo`;
const KEYCHAIN_SERVICE = "cursor-access-token";
const KEYCHAIN_ACCOUNT = "cursor-user";

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
      return await readLinuxSecretToken();
    }
    if (process.platform === "win32") {
      return await readWindowsCredentialToken();
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Could not read Cursor CLI credentials: ${detail}`);
  }

  throw new UsageError("Unsupported platform for Cursor CLI credential lookup.");
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

async function readWindowsCredentialToken(): Promise<string> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CursorCredReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) { return null; }
    try {
      var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0) { return null; }
      return Marshal.PtrToStringUni(cred.CredentialBlob, (int)cred.CredentialBlobSize / 2);
    } finally { CredFree(ptr); }
  }
}
"@
$targets = @(
  '${KEYCHAIN_SERVICE}',
  '${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}',
  'LegacyGeneric:target=${KEYCHAIN_SERVICE}'
)
foreach ($target in $targets) {
  $value = [CursorCredReader]::Read($target)
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    Write-Output $value
    exit 0
  }
}
exit 1
`.trim();

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 8_000, maxBuffer: 1024 * 1024, windowsHide: true }
  );
  const token = stdout.trim();
  if (!token) {
    throw new Error("credential not found");
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
