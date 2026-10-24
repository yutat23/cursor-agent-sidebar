import { PlanTodo } from "./acpClient";
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

export interface QuestionAnswer {
  questionId: string;
  selectedOptionIds: string[];
}

export interface QuestionRequestState {
  resolve: (answers: QuestionAnswer[]) => void;
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
  // Tool kinds by tool call id; updates after the first usually omit the kind.
  readonly toolKinds = new Map<string, string>();
  // Tool calls not shown as activity rows (the todo card already shows them).
  readonly hiddenToolCalls = new Set<string>();
  // The agent's todo list; it carries over between turns.
  todos: PlanTodo[] = [];
  readonly changeReviewItems = new Map<string, ChangeReviewItem>();
  readonly permissionRequests = new Map<string, PermissionRequestState>();
  readonly planRequests = new Map<string, PlanRequestState>();
  readonly questionRequests = new Map<string, QuestionRequestState>();
  private readonly thread: ThreadMessage[] = [];
  private assistantOpen = false;
  // The current turn's todo card, updated in place as the list changes.
  private turnTodos?: ThreadMessage;

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
      this.turnTodos = undefined;
    } else if (message.type === "assistantDone") {
      this.assistantOpen = false;
    }

    if (message.type === "todos") {
      if (this.turnTodos) {
        this.turnTodos.todos = message.todos;
        return;
      }
      this.turnTodos = { ...message };
      this.thread.push(this.turnTodos);
      return;
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

  /** Applies a todo update from the agent: a full list, or changes merged by id. */
  updateTodos(todos: PlanTodo[], merge: boolean): PlanTodo[] {
    if (!merge) {
      this.todos = todos;
      return this.todos;
    }
    const next = [...this.todos];
    for (const todo of todos) {
      const index = next.findIndex((t) => t.id === todo.id);
      if (index >= 0) {
        next[index] = { ...next[index], ...todo };
      } else {
        next.push(todo);
      }
    }
    this.todos = next;
    return this.todos;
  }

  /** Drops an answered card so it is not replayed as pending. */
  forget(type: "permissionRequest" | "planRequest" | "questionRequest", id: string): void {
    const index = this.thread.findIndex((m) => m.type === type && m.id === id);
    if (index >= 0) {
      this.thread.splice(index, 1);
    }
  }
}
