import { AgentMode } from "./acpClient";

export interface AcpModeOption {
  id: string;
  name: string;
  description?: string;
}

export interface AcpModelOption {
  id: string;
  name: string;
  description?: string;
}

export interface SessionPickerConfig {
  sessionId?: string;
  modes: AcpModeOption[];
  models: AcpModelOption[];
  currentModeId: AgentMode;
  currentModelId: string;
}

export interface AcpSessionInfo {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: string;
}

interface ConfigOption {
  id: string;
  currentValue: string;
  options: Array<{ value: string; name: string; description?: string }>;
}

interface NewSessionResult {
  sessionId: string;
  modes?: {
    currentModeId: string;
    availableModes: Array<{ id: string; name: string; description?: string }>;
  };
  models?: {
    currentModelId: string;
    availableModels: Array<{ modelId: string; name: string }>;
  };
  configOptions?: ConfigOption[];
}

export function parseSessionConfig(result: NewSessionResult): SessionPickerConfig {
  const modeOption = result.configOptions?.find((o) => o.id === "mode");
  const modelOption = result.configOptions?.find((o) => o.id === "model");

  const modes: AcpModeOption[] =
    modeOption?.options.map((o) => ({
      id: o.value,
      name: o.name,
      description: o.description,
    })) ??
    result.modes?.availableModes.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
    })) ??
    [];

  const models: AcpModelOption[] =
    modelOption?.options.map((o) => ({
      id: o.value,
      name: formatModelDisplayName(o.value, o.name),
      description: o.description,
    })) ??
    result.models?.availableModels.map((m) => ({
      id: m.modelId,
      name: formatModelDisplayName(m.modelId, m.name),
    })) ??
    [];

  const currentModeId = (modeOption?.currentValue ??
    result.modes?.currentModeId ??
    "agent") as AgentMode;

  const currentModelId = modelOption?.currentValue ?? result.models?.currentModelId ?? "default[]";

  return {
    sessionId: result.sessionId,
    modes,
    models,
    currentModeId,
    currentModelId,
  };
}

export function parseConfigOptions(configOptions: ConfigOption[]): SessionPickerConfig {
  return parseSessionConfig({ sessionId: "", configOptions });
}

export function formatModelDisplayName(modelId: string, name: string): string {
  if (modelId.startsWith("default")) {
    return "Auto";
  }

  if (name.startsWith("composer")) {
    return /fast=true/.test(modelId) ? "Composer 2.5 Fast" : "Composer 2.5";
  }

  if (name.startsWith("claude-opus")) {
    const version = name.match(/4-\d+/)?.[0]?.replace("-", ".") ?? "";
    const parts = [`Opus ${version}`];
    if (/thinking=true/.test(modelId)) {
      parts.push("Thinking");
    }
    const effort = modelId.match(/effort=([^,\]]+)/)?.[1];
    if (effort && effort !== "medium") {
      parts.push(capitalize(effort));
    } else if (effort === "high" || (!effort && /thinking=true/.test(modelId))) {
      parts.push("High");
    }
    if (/fast=true/.test(modelId)) {
      parts.push("Fast");
    }
    return parts.join(" ");
  }

  if (name.startsWith("claude-sonnet")) {
    const version = name.match(/4-\d+/)?.[0]?.replace("-", ".") ?? "";
    const parts = [`Sonnet ${version}`];
    if (/thinking=true/.test(modelId)) {
      parts.push("Thinking");
    }
    return parts.join(" ");
  }

  if (name.startsWith("gpt-")) {
    const parts = [name.replace(/^gpt-/, "GPT-").replace(/-/g, ".")];
    const reasoning = modelId.match(/reasoning=([^,\]]+)/)?.[1];
    if (reasoning && reasoning !== "medium") {
      parts.push(capitalize(reasoning));
    }
    if (/fast=true/.test(modelId)) {
      parts.push("Fast");
    }
    return parts.join(" ");
  }

  if (name.startsWith("gpt-5.3-codex") || name.includes("codex")) {
    const parts = ["Codex"];
    const version = name.match(/\d+\.\d+/)?.[0];
    if (version) {
      parts.push(version);
    }
    const reasoning = modelId.match(/reasoning=([^,\]]+)/)?.[1];
    if (reasoning) {
      parts.push(capitalize(reasoning));
    }
    return parts.join(" ");
  }

  return name
    .split("-")
    .map((part) => capitalize(part))
    .join(" ");
}

function capitalize(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}
