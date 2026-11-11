import type { Task as DomainTask, Notice, Plan } from "../src/domain.ts";
import type { Project, Settings } from "../src/workspace.ts";
import type { ResearchConversation } from "../packages/research/cloud-workflow.ts";
import type { Chunk } from "../packages/research/core.ts";
import type { Artifact } from "../src/artifacts.ts";
export type { Project, Settings, Notice, Plan, Chunk, Artifact };
export type Task = Omit<DomainTask, "modelPrompt">;
export type Conversation = Pick<
  ResearchConversation,
  | "id"
  | "title"
  | "projectId"
  | "scope"
  | "created"
  | "updated"
  | "pinned"
  | "archived"
>;
export interface Page<T> {
  items: T[];
  nextCursor: string | number | null;
}
export interface Paper {
  paper_id: string;
  title: string;
  abstract: string;
  indexVersion: string;
  originalUrl?: string;
  localUrl?: string;
}
export interface Account {
  id: string;
  name: string;
  role: "owner" | "member";
}
export interface AuthStatus {
  bootstrapAvailable: boolean;
  account: Account | null;
}
export interface Budget {
  month: string;
  limit: number;
  backgroundLimit: number;
  estimatedSpent: number;
  reserved: number;
  remaining: number;
  backgroundSpent: number;
  backgroundReserved: number;
  warning: boolean;
  backgroundPaused: boolean;
  blocked: boolean;
  priceId: string;
  priceSource: string;
  scope: string;
}
export interface Overview {
  settings: Settings;
  projects: Page<Project>;
  conversations: Page<Conversation>;
  tasks: Task[];
  notices: Notice[];
  plans: Plan[];
  memoryCount: number;
  deviceOnline: boolean;
  cursor: number;
  build: string;
  model: { id: string; mode: string; thinking: string };
}
export interface Memory {
  id: string;
  kind: string;
  content: string;
  source_session: string;
  source_turn: string;
  paper_ids: string[];
  updated_at: string;
  edited: boolean;
}
export interface SavedArtifact extends Artifact {
  content: string;
  sources: Chunk[];
  editor: string;
}
