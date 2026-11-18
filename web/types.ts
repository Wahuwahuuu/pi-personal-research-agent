import type {ArtifactKind} from "../src/artifact-contract.ts";
import type { Task as DomainTask, Notice, Plan } from "../src/domain.ts";
import type { Project, Settings } from "../src/workspace.ts";
import type { ResearchConversation } from "../packages/research/cloud-workflow.ts";
import type { Chunk } from "../packages/research/core.ts";
import type { Artifact } from "../src/artifacts.ts";
export type { Project, Settings, Notice, Plan, Chunk, Artifact };
export const artifactLabels: Record<ArtifactKind, string> = {
  reading: "阅读卡", comparison: "比较研究", review: "主题综述", brief: "阶段简报",
};
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
  pendingCount?: number;
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
  deviceState?: {connected:boolean;ready:boolean;phase:string;canImport:boolean};
  cursor: number;
  build: string;
  model: { id: string; mode: string; thinking: string };
}
export type { CloudMemoryEntry as Memory } from "../packages/research/cloud-memory.ts";
export interface SavedArtifact extends Artifact {
  comparison?: import("../src/comparison-evidence.ts").ComparisonSnapshot;
  content: string;
  sources: Chunk[];
  editor: string;
}
