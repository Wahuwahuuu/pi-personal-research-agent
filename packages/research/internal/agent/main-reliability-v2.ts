/** Bounded host formatting and routing adapters; no Gold, fuzzy source matching or extra model. */
import { RuntimeFailure, type Chunk } from "./contracts.ts";
import { parseFinalAnswer, type AnswerKind } from "./final-answer.ts";
import { parseQuestionPreparation, type PreparationContext } from "./question-preparation.ts";
import { parseFullCheck } from "./full-stages-main-v2.ts";
import type { QuestionFrame } from "./p2-stages.ts";
import type { R2Check } from "./p2-r2.ts";

import { decodeCandidateJSON, type Audit } from "./candidate-json.ts";
export { decodeCandidateJSON, type Audit } from "./candidate-json.ts";

export function parseCandidateFinal(response: string, evidence: ReadonlyMap<string, Chunk>, allowAnswer: boolean, ambiguity: boolean, kind?: AnswerKind, audit?: Audit) {
  let json: string;
  try { json = decodeCandidateJSON(response, audit); }
  catch (error) { throw new RuntimeFailure("ANSWER_SCHEMA_ERROR", error instanceof Error ? error.message : "Invalid JSON"); }
  return parseFinalAnswer(json, evidence, allowAnswer, ambiguity, kind);
}

export function parseCandidatePreparation(response: string, context: PreparationContext, audit: Audit = () => {}) {
  const json = decodeCandidateJSON(response, audit), value = JSON.parse(json);
  const raw = value.preparation ?? value;
  const prepared = parseQuestionPreparation(json, context);
  if (["paper_discovery", "session_control"].includes(prepared.frame.intent) && prepared.frame.ordered_targets.length && Array.isArray(raw.queries) && raw.queries.length) {
    audit("catalog_query_conflict_original_question_fallback");
    throw new RuntimeFailure("PREPARATION_ERROR", "Nonfactual intent conflicts with a resolved paper and retrieval queries; preserve the original question and fall back to autonomous retrieval");
  }
  return prepared;
}

export function parseCandidateCheck(response: string, frame: QuestionFrame, allowed: ReadonlySet<string>, evidence: ReadonlyMap<string, Chunk>, previous?: R2Check, audit: Audit = () => {}) {
  try {
    const json = decodeCandidateJSON(response, audit), raw = JSON.parse(json);
    if (Array.isArray(raw.checks)) for (const item of raw.checks) {
      if (!item || typeof item !== "object") continue;
      const prior = previous?.checks.find(c => c.need_id === item.need_id);
      const upgrading = Boolean(item.status === "supported" && prior && prior.status !== "supported");
      if (!upgrading && item.gap_resolution != null) audit("unused_gap_resolution_ignored");
      if (Array.isArray(item.support_spans)) {
        if (item.support_spans.length > 2) audit("bounded_multi_span_support");
        for (const span of item.support_spans) {
          if (!span || typeof span.quote !== "string") continue;
          const source = evidence.get(span.chunk_id);
          if (!source || source.text.includes(span.quote)) continue;
          const restored = span.quote.replace(/\\(["\\])/gu, "$1"), at = source.text.indexOf(restored);
          if (restored !== span.quote && at >= 0 && source.text.indexOf(restored, at + 1) < 0) {
            span.quote = restored; audit("source_proven_quote_escape_restored");
          }
        }
      }
    }
    return parseFullCheck(JSON.stringify(raw), frame, allowed, evidence, previous);
  } catch (error) { throw new RuntimeFailure("CHECK_ERROR", error instanceof Error ? error.message : "Invalid candidate check"); }
}
