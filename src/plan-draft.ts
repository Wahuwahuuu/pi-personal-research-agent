import { text } from "./domain.ts";
export interface PlanDraft {
  objective: string;
  query: string;
  maxPapers: number;
  warnings: string[];
}
/** Conservative, free draft extraction. Unknown keywords/times are reviewed by the user. */
export function draftPlan(input: unknown): PlanDraft {
  const value = text(input, 2000),
    warnings: string[] = [];
  const objective =
    value
      .replace(
        /^(?:请|帮我|请帮我)?\s*(?:(?:每天|每日)\s*)?(?:关注|追踪|跟踪)\s*/u,
        "",
      )
      .trim() || value;
  const latin = value.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? [];
  const noise = new Set([
    "arxiv",
    "daily",
    "every",
    "day",
    "watch",
    "track",
    "follow",
    "paper",
    "papers",
  ]);
  const query = [
    ...new Set(latin.filter((word) => !noise.has(word.toLowerCase()))),
  ]
    .join(" ")
    .slice(0, 300);
  if (!query)
    warnings.push(
      "请补充 arXiv 英文检索词。研究目标可以保留中文，系统不会猜测翻译。",
    );
  if (
    /每周|每月|每小时|每隔|weekly|monthly|hourly|\d+\s*(?:点|:|：)/iu.test(
      value,
    )
  )
    warnings.push(
      "当前按每天 09:00（上海时间）检查，请核对这一频率是否符合你的要求。",
    );
  const match = value.match(/(?:最多|不超过|至多)\s*(\d+|一|二|两|三)\s*篇/u);
  const number = match
    ? Number(
        ({ 一: 1, 二: 2, 两: 2, 三: 3 } as Record<string, number>)[match[1]] ??
          match[1],
      )
    : 3;
  if (number < 1 || number > 3)
    warnings.push("每轮深入处理支持 1 至 3 篇，其余候选保留到后续周期。");
  return {
    objective,
    query,
    maxPapers: Math.max(1, Math.min(3, number)),
    warnings,
  };
}
