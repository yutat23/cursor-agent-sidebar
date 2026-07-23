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

export interface AcpModelParameterOption {
  value: string;
  name: string;
}

export interface AcpModelParameter {
  id: string;
  name: string;
  description?: string;
  category: string;
  currentValue: string;
  options: AcpModelParameterOption[];
}

export interface SessionPickerConfig {
  sessionId?: string;
  modes: AcpModeOption[];
  models: AcpModelOption[];
  modelParameters: AcpModelParameter[];
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
  name?: string;
  description?: string;
  category?: string;
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

const MODEL_PARAM_CATEGORIES = new Set(["model_config", "thought_level"]);

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
      id: normalizeModelId(o.value),
      name: cleanDisplayName(o.name) || formatModelDisplayName(o.value, o.name),
      description: o.description,
    })) ??
    result.models?.availableModels.map((m) => ({
      id: normalizeModelId(m.modelId),
      name: cleanDisplayName(m.name) || formatModelDisplayName(m.modelId, m.name),
    })) ??
    [];

  const modelParameters: AcpModelParameter[] =
    result.configOptions
      ?.filter((o) => o.id !== "mode" && o.id !== "model" && isModelParameterOption(o))
      .map((o) => ({
        id: o.id,
        name: cleanDisplayName(o.name || o.id),
        description: o.description,
        category: o.category || "model_config",
        currentValue: o.currentValue,
        options: o.options.map((opt) => ({
          value: opt.value,
          name: cleanDisplayName(opt.name || opt.value),
        })),
      })) ?? [];

  const currentModeId = (modeOption?.currentValue ??
    result.modes?.currentModeId ??
    "agent") as AgentMode;

  const currentModelId = normalizeModelId(
    modelOption?.currentValue ?? result.models?.currentModelId ?? "default"
  );

  return {
    sessionId: result.sessionId,
    modes,
    models,
    modelParameters,
    currentModeId,
    currentModelId,
  };
}

export function parseConfigOptions(configOptions: ConfigOption[]): SessionPickerConfig {
  return parseSessionConfig({ sessionId: "", configOptions });
}

export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return "default";
  }
  const bracket = trimmed.indexOf("[");
  return bracket >= 0 ? trimmed.slice(0, bracket) : trimmed;
}

export function parseModelIdParameters(modelId: string): Array<{ id: string; value: string }> {
  const match = modelId.match(/\[([^\]]*)\]/);
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq < 0) {
        return { id: part, value: "true" };
      }
      return { id: part.slice(0, eq), value: part.slice(eq + 1) };
    })
    .filter((param) => param.id);
}

export function formatModelParamSummary(parameters: AcpModelParameter[]): string {
  const parts: string[] = [];

  for (const param of parameters) {
    const selected = param.options.find((o) => o.value === param.currentValue);
    const label = selected?.name || param.currentValue;

    if (param.id === "thinking") {
      continue;
    }

    if (param.options.every((o) => o.value === "true" || o.value === "false")) {
      if (param.currentValue === "true") {
        parts.push(param.name || label);
      }
      continue;
    }

    if (param.options.length <= 1) {
      continue;
    }

    parts.push(label);
  }

  return parts.join(" ");
}

export function formatCurrentModelLabel(
  modelId: string,
  modelName: string | undefined,
  parameters: AcpModelParameter[]
): string {
  const base =
    cleanDisplayName(modelName) ||
    formatModelDisplayName(modelId, modelName || "") ||
    modelId;

  if (normalizeModelId(modelId) === "default") {
    return base || "Auto";
  }

  const summary = formatModelParamSummary(parameters);
  return summary ? `${base} ${summary}` : base;
}

export function formatModelDisplayName(modelId: string, name: string): string {
  const baseId = normalizeModelId(modelId);

  if (baseId === "default" || baseId.startsWith("default")) {
    return "Auto";
  }

  if (name.startsWith("composer") || baseId.startsWith("composer")) {
    return /fast=true/.test(modelId) ? "Composer 2.5 Fast" : "Composer 2.5";
  }

  if (name.startsWith("claude-opus") || baseId.startsWith("claude-opus")) {
    const version = (name || baseId).match(/4-\d+/)?.[0]?.replace("-", ".") ?? "";
    const parts = [`Opus ${version}`.trim()];
    if (/thinking=true/.test(modelId)) {
      parts.push("Thinking");
    }
    const effort = modelId.match(/effort=([^,\]]+)/)?.[1];
    if (effort && effort !== "medium") {
      parts.push(capitalize(effort === "xhigh" ? "Extra High" : effort));
    } else if (effort === "high" || (!effort && /thinking=true/.test(modelId))) {
      parts.push("High");
    }
    if (/fast=true/.test(modelId)) {
      parts.push("Fast");
    }
    return parts.filter(Boolean).join(" ");
  }

  if (name.startsWith("claude-sonnet") || baseId.startsWith("claude-sonnet")) {
    const version = (name || baseId).match(/4-\d+|5/)?.[0]?.replace("-", ".") ?? "";
    const parts = [`Sonnet ${version}`.trim()];
    if (/thinking=true/.test(modelId)) {
      parts.push("Thinking");
    }
    return parts.filter(Boolean).join(" ");
  }

  if (name.startsWith("gpt-") || baseId.startsWith("gpt-")) {
    const parts = [(name || baseId).replace(/^gpt-/, "GPT-").replace(/-/g, ".")];
    const reasoning = modelId.match(/reasoning=([^,\]]+)/)?.[1];
    if (reasoning && reasoning !== "medium") {
      parts.push(capitalize(reasoning === "xhigh" ? "Extra High" : reasoning));
    }
    if (/fast=true/.test(modelId)) {
      parts.push("Fast");
    }
    return parts.join(" ");
  }

  if (name.includes("codex") || baseId.includes("codex")) {
    const parts = ["Codex"];
    const version = (name || baseId).match(/\d+\.\d+/)?.[0];
    if (version) {
      parts.push(version);
    }
    const reasoning = modelId.match(/reasoning=([^,\]]+)/)?.[1];
    if (reasoning) {
      parts.push(capitalize(reasoning === "xhigh" ? "Extra High" : reasoning));
    }
    return parts.join(" ");
  }

  if (name) {
    return cleanDisplayName(name);
  }

  return baseId
    .split("-")
    .map((part) => capitalize(part))
    .join(" ");
}

function isModelParameterOption(option: ConfigOption): boolean {
  if (option.category && MODEL_PARAM_CATEGORIES.has(option.category)) {
    return true;
  }

  // Fallback for older agents that omit category but still expose params.
  return Boolean(option.options?.length) && option.id !== "mode" && option.id !== "model";
}

function cleanDisplayName(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value.replace(/[\u200b\u200c\u200d\ufeff]/g, "").trim();
}

function capitalize(value: string): string {
  if (!value) {
    return value;
  }
  if (value === "xhigh") {
    return "Extra High";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}
