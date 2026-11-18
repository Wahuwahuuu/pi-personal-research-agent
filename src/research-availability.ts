import {newWorkflow} from "../packages/research/cloud-workflow.ts";
import type {Task} from "./domain.ts";
import type {ResearchCatalog} from "./research-catalog.ts";

const reasons = {library: "PAPER_LIBRARY_EMPTY", scope: "SCOPE_PAPERS_UNAVAILABLE"} as const;

function missingPapers(catalog: ResearchCatalog, scope: readonly string[]): Task["paperWait"] {
  if (!catalog.papers.length) return scope.length ? "scope" : "library";
  if (scope.length && !catalog.papers.some(p => scope.includes(p.paper_id))) return "scope";
}

function beforeRetrieval(t: Task) {
  return !t.runOpen && !t.pauseRequested && !t.proactive && !t.translationKey &&
    t.tools === 0 && !t.researchEvidence?.length;
}

function wait(t: Task, reason: NonNullable<Task["paperWait"]>) {
  if (t.status === "waiting_user" && t.paperWait === reason && t.error === reasons[reason]) return false;
  t.paperWait = reason;
  t.status = "waiting_user";
  t.error = reasons[reason];
  t.updated = Date.now();
  return true;
}

/** Only a factual request prepared against an actual snapshot can establish a paper wait. */
export function holdForMissingPapers(t: Task, catalog: ResearchCatalog, scope: readonly string[]) {
  const workflow = t.workflow, frame = workflow?.prepared?.frame;
  if (!beforeRetrieval(t) || t.status !== "queued" || !frame || workflow?.phase !== "agent" ||
      workflow.cloudOnly || frame.ambiguity || ["session_control", "paper_discovery"].includes(frame.intent) ||
      catalog.indexVersion === "cloud-only" || t.researchIndex !== catalog.indexVersion) return false;
  if (workflow.preparedIndex !== catalog.indexVersion &&
      !(workflow.automatic && workflow.preparedIndex === "cloud-only")) return false;
  const reason = missingPapers(catalog, scope);
  return reason ? wait(t, reason) : false;
}

/** A task which has never read a source can bind its first usable snapshot on publication. */
export function revisitPaperWait(t: Task, catalog: ResearchCatalog | undefined, scope: readonly string[]) {
  if (!t.paperWait || !beforeRetrieval(t) || !["waiting_user", "queued", "waiting_device"].includes(t.status) ||
      (t.error && t.error !== reasons[t.paperWait])) return false;
  if (!catalog || catalog.indexVersion === "cloud-only") {
    if (t.status !== "queued") return false;
    t.status = "waiting_device";
    t.error = undefined;
    t.updated = Date.now();
    return true;
  }
  const reason = missingPapers(catalog, scope);
  if (reason) return wait(t, reason);
  delete t.paperWait;
  t.researchIndex = catalog.indexVersion;
  t.workflow = {...newWorkflow(), automatic: t.kind === "auto", cloudOnly: false};
  t.status = "queued";
  t.error = undefined;
  t.updated = Date.now();
  return true;
}

/** Previously classified offline requests retain a Pi session while they await their first real catalog. */
export function awaitsResearchCatalog(t: Task) {
  return !!t.paperWait || (!t.researchIndex && t.tools === 0 &&
    (t.workflow?.preparedIndex === "cloud-only" || t.workflow?.phase === "prepare"));
}
