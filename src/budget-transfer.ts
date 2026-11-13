import { Problem } from "./domain.ts";
import type { StateStorage } from "./state-store.ts";
import { ValidationBudget } from "./validation-budget.ts";

export interface BudgetCarryover {
  version: 1;
  source: string;
  sealedAt: number;
  validation: { requests: number; input: number; output: number };
  months: { month: string; spent: number; background: number; days: { day: string; spent: number }[] }[];
}
export interface BudgetDeployment { frozen: boolean; carryovers: BudgetCarryover[] }
const invalid = () => new Problem("BUDGET_CARRYOVER_INVALID", 503);
function record(value: unknown, fields: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const v = value as Record<string, any>;
  if (Object.keys(v).length !== fields.length || fields.some(k => !Object.hasOwn(v, k))) throw invalid();
  return v;
}
function count(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 1_000_000_000_000) throw invalid();
  return v;
}
function date(value: unknown, monthOnly = false): string {
  if (typeof value !== "string" || !(monthOnly ? /^20\d{2}-(0[1-9]|1[0-2])$/ : /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).test(value)) throw invalid();
  if (!monthOnly && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value) throw invalid();
  return value;
}
export function parseCarryover(value: unknown): BudgetCarryover {
  const v = record(value, ["version", "source", "sealedAt", "validation", "months"]);
  if (v.version !== 1 || typeof v.source !== "string" || !/^(ledger|legacy):[a-zA-Z0-9._-]{1,80}$/.test(v.source)) throw invalid();
  if (!Number.isSafeInteger(v.sealedAt) || v.sealedAt < 0 || v.sealedAt > 8_000_000_000_000) throw invalid();
  const usage = record(v.validation, ["requests", "input", "output"]);
  if (!Array.isArray(v.months) || v.months.length > 24) throw invalid();
  const months = v.months.map((raw: unknown) => {
    const m = record(raw, ["month", "spent", "background", "days"]), month = date(m.month, true);
    if (!Array.isArray(m.days) || m.days.length > 31) throw invalid();
    const days = m.days.map((rawDay: unknown) => {
      const d = record(rawDay, ["day", "spent"]), day = date(d.day);
      if (!day.startsWith(month + "-")) throw invalid();
      return { day, spent: count(d.spent) };
    }).sort((a, b) => a.day.localeCompare(b.day));
    const spent = count(m.spent), background = count(m.background);
    if (background > spent || days.reduce((n, d) => n + d.spent, 0) !== background || new Set(days.map(d => d.day)).size !== days.length) throw invalid();
    return { month, spent, background, days };
  }).sort((a, b) => a.month.localeCompare(b.month));
  if (new Set(months.map(m => m.month)).size !== months.length) throw invalid();
  return { version: 1, source: v.source, sealedAt: v.sealedAt, validation: { requests: count(usage.requests), input: count(usage.input), output: count(usage.output) }, months };
}
export function parseBudgetDeployment(value: unknown): BudgetDeployment {
  if (value === undefined) return { frozen: false, carryovers: [] };
  const v = record(value, ["frozen", "carryovers"]);
  if (typeof v.frozen !== "boolean" || !Array.isArray(v.carryovers) || v.carryovers.length > 8) throw invalid();
  const carryovers = v.carryovers.map(parseCarryover).sort((a, b) => a.source.localeCompare(b.source));
  if (new Set(carryovers.map(c => c.source)).size !== carryovers.length) throw invalid();
  const parsed = { frozen: v.frozen, carryovers };
  // One plaintext binding stays below Cloudflare's 5 KB variable limit.
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 4096) throw invalid();
  return parsed;
}
export function budgetDeploymentVariables(value: unknown): Record<string, string> {
  return value === undefined ? {} : { BUDGET_DEPLOYMENT: JSON.stringify(parseBudgetDeployment(value)) };
}
export function readBudgetDeployment(raw: string | undefined): BudgetDeployment {
  if (raw === undefined) return parseBudgetDeployment(undefined);
  try { if (typeof raw !== "string" || raw.length > 8192) throw invalid(); return parseBudgetDeployment(JSON.parse(raw)); }
  catch { throw invalid(); }
}

/** Operator-selected numeric receipts; this is a handoff, not a distributed live ledger. */
export class BudgetTransfer {
  readonly db: StateStorage;
  readonly validation: ValidationBudget;
  constructor(db: StateStorage, validation: ValidationBudget) {
    this.db = db; this.validation = validation;
    db.sql.exec("CREATE TABLE IF NOT EXISTS pra_budget_carryovers(source TEXT PRIMARY KEY,value TEXT NOT NULL)");
    db.sql.exec("CREATE TABLE IF NOT EXISTS pra_budget_transfer(singleton INTEGER PRIMARY KEY CHECK(singleton=1),source TEXT NOT NULL,receipt TEXT)");
    if (!db.sql.exec("SELECT source FROM pra_budget_transfer WHERE singleton=1").toArray().length)
      db.sql.exec("INSERT OR IGNORE INTO pra_budget_transfer VALUES(1,?,NULL)", "ledger:" + crypto.randomUUID());
  }
  private current() { return this.db.sql.exec<{source: string; receipt: string | null}>("SELECT source,receipt FROM pra_budget_transfer WHERE singleton=1").toArray()[0]!; }
  view() {
    const row = this.current();
    return { source: row.source, sealed: row.receipt !== null, receipt: row.receipt ? parseCarryover(JSON.parse(row.receipt)) : null,
      importedSources: this.db.sql.exec<{source: string}>("SELECT source FROM pra_budget_carryovers ORDER BY source").toArray().map(r => r.source) };
  }
  assertOpen() { if (this.current().receipt !== null) throw new Problem("BUDGET_TRANSFER_SEALED", 429); }
  apply(carryovers: BudgetCarryover[]) {
    const parsed = carryovers.map(parseCarryover);
    this.db.transactionSync(() => {
      for (const receipt of parsed) {
        const value = JSON.stringify(receipt), old = this.db.sql.exec<{value: string}>("SELECT value FROM pra_budget_carryovers WHERE source=?", receipt.source).toArray()[0];
        if (old) { if (old.value !== value) throw new Problem("BUDGET_CARRYOVER_CONFLICT", 503); continue; }
        this.assertOpen();
        if (receipt.source === this.current().source) throw new Problem("BUDGET_CARRYOVER_SELF", 503);
        this.validation.import("external-budget:" + receipt.source, receipt.validation);
        for (const m of receipt.months) {
          this.db.sql.exec("INSERT INTO pra_budget_months(month,spent,background) VALUES(?,?,?) ON CONFLICT(month) DO UPDATE SET spent=spent+excluded.spent,background=background+excluded.background", m.month, m.spent, m.background);
          for (const d of m.days) this.db.sql.exec("INSERT INTO pra_budget_days(day,spent) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET spent=spent+excluded.spent", d.day, d.spent);
        }
        this.db.sql.exec("INSERT INTO pra_budget_carryovers VALUES(?,?)", receipt.source, value);
      }
    });
  }
  seal(now = Date.now()): BudgetCarryover {
    return this.db.transactionSync(() => {
      const current = this.current();
      if (current.receipt) return parseCarryover(JSON.parse(current.receipt));
      if (this.db.sql.exec("SELECT id FROM pra_model_calls WHERE status='reserved' LIMIT 1").toArray().length ||
          this.db.sql.exec("SELECT id FROM pra_validation_calls WHERE status='reserved' LIMIT 1").toArray().length)
        throw new Problem("BUDGET_IN_FLIGHT", 409);
      // Imports are separate origins. Export only calls admitted by this ledger itself.
      const usage = this.db.sql.exec<{requests: number; input: number; output: number}>("SELECT COUNT(*) AS requests,COALESCE(SUM(input),0) AS input,COALESCE(SUM(output),0) AS output FROM pra_validation_calls").toArray()[0]!;
      const rows = this.db.sql.exec<{month: string; day: string; background: number; charged: number; input: number | null; output: number | null}>("SELECT c.month,c.day,c.background,c.charged,c.input,c.output FROM pra_model_calls c JOIN pra_validation_calls v ON c.id=v.id ORDER BY c.month,c.day,c.id").toArray();
      if (rows.length !== usage.requests || rows.some(r => !Number.isSafeInteger(r.charged) || r.charged < 0)) throw new Problem("BUDGET_LEDGER_INCOMPLETE", 503);
      const months: BudgetCarryover["months"] = [];
      for (const row of rows) {
        let m = months.find(m => m.month === row.month);
        if (!m) { m = {month: row.month, spent: 0, background: 0, days: []}; months.push(m); }
        m.spent += row.charged;
        if (row.background) {
          m.background += row.charged;
          let d = m.days.find(d => d.day === row.day);
          if (!d) { d = {day: row.day, spent: 0}; m.days.push(d); }
          d.spent += row.charged;
        }
      }
      const receipt = parseCarryover({version: 1, source: current.source, sealedAt: now, validation: usage, months});
      // Never seal an origin whose complete receipt cannot be carried by the supported deployment binding.
      parseBudgetDeployment({frozen: false, carryovers: [receipt]});
      this.db.sql.exec("UPDATE pra_budget_transfer SET receipt=? WHERE singleton=1", JSON.stringify(receipt));
      return receipt;
    });
  }
}
