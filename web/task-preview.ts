import type { Task } from "./types.ts";

export interface TaskPreview {
  type: "task-preview";
  id: string;
  conversationId: string;
  operation: string;
  updated: number;
  text: string;
}

export function isTaskPreview(value: unknown): value is TaskPreview {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<TaskPreview>;
  return p.type === "task-preview" && typeof p.id === "string" &&
    typeof p.conversationId === "string" && typeof p.operation === "string" &&
    typeof p.updated === "number" && Number.isFinite(p.updated) &&
    typeof p.text === "string";
}

export function withTaskPreview(task: Task, preview?: TaskPreview): Task {
  if (!preview || task.answer || task.status !== "running" || !task.runOpen ||
      task.pauseRequested || task.id !== preview.id ||
      task.conversationId !== preview.conversationId ||
      task.modelOperation !== preview.operation || task.updated !== preview.updated) return task;
  return { ...task, preview: preview.text };
}
