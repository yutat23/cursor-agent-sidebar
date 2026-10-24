import { PromptImageAttachment } from "./promptBuilder";
import { SessionPickerConfig } from "./sessionConfig";
import { FileEditCardData } from "./toolCallParser";

export interface PermissionPresentation {
  headline: string;
  detail: string;
  icon: string;
}

export interface PermissionRequestState {
  resolve: (decision: string) => void;
  title: string;
  kind?: string;
  presentation: PermissionPresentation;
}

export interface PlanRequestState {
  resolve: (outcome: string) => void;
}

export interface ChangeReviewItem {
  path: string;
  fileName: string;
  status: string;
  addedLines: number;
  removedLines: number;
  previewLines: FileEditCardData["previewLines"];
  previousText?: string | null;
  canRevert: boolean;
  updatedAt: string;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  images: PromptImageAttachment[];
  kind: "queue" | "interrupt";
}

export interface Turn {
  stopping: boolean;
  // Send the first queued prompt once the cancel completes.
  drainAfterCancel: boolean;
}

export type ThreadMessage = Record<string, unknown> & { type: string };

/**
 * One agent session as this window knows it. Sessions keep running and
 * recording while another one is shown, so switching back replays exactly
 * what the user would have seen, including a turn that is still running.
 */
export class ChatSession {
  config?: SessionPickerConfig;
  // Set while the agent replays a saved session's history into it.
  loading?: Promise<void>;
  turn?: Turn;
  queue: QueuedPrompt[] = [];
  readonly fileEdits = new Map<string, FileEditCardData>();
  readonly changeReviewItems = new Map<string, ChangeReviewItem>();
  readonly permissionRequests = new Map<string, PermissionRequestState>();
  readonly planRequests = new Map<string, PlanRequestState>();
  private readonly thread: ThreadMessage[] = [];
  private assistantOpen = false;

  constructor(readonly id: string, config?: SessionPickerConfig) {
    this.config = config;
  }

  get isAssistantOpen(): boolean {
    return this.assistantOpen;
  }

  get hasHistory(): boolean {
    return this.thread.some((m) => m.type === "userMessage" || m.type === "assistantChunk");
  }

  get messages(): readonly ThreadMessage[] {
    return this.thread;
  }

  /** Records a message shown in this session's thread. */
  record(message: ThreadMessage): void {
    if (message.type === "assistantStart") {
      this.assistantOpen = true;
    } else if (message.type === "assistantDone") {
      this.assistantOpen = false;
    }

    const last = this.thread[this.thread.length - 1];
    if (
      last &&
      last.type === message.type &&
      (message.type === "assistantChunk" || message.type === "thinking") &&
      typeof last.text === "string" &&
      typeof message.text === "string"
    ) {
      last.text += message.text;
      return;
    }
    this.thread.push({ ...message });
  }

  /** Drops an answered permission or plan card so it is not replayed as pending. */
  forget(type: "permissionRequest" | "planRequest", id: string): void {
    const index = this.thread.findIndex((m) => m.type === type && m.id === id);
    if (index >= 0) {
      this.thread.splice(index, 1);
    }
  }
}
