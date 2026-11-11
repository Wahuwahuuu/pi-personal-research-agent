import { initialState, Problem, type State } from "./domain.ts";

export interface SqlRows<T = Record<string, unknown>> { toArray(): T[] }
export interface SqlPort {
  exec<T = Record<string, unknown>>(query: string, ...bindings: any[]): SqlRows<T>;
}
export interface StateStorage { sql: SqlPort; transactionSync<T>(fn: () => T): T }
const collections = ["tasks", "operations", "memories", "notices", "plans", "papers", "conversations", "messages", "memory_entries"] as const;
export type Collection = (typeof collections)[number];
interface Row { id: string; parent: string; position: number; value: string }
const table = (name: Collection) => "pra_data_" + name;
const serial = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: string): T => JSON.parse(v);
const validCollection = (name: string): name is Collection => collections.includes(name as Collection);

/** SQL persistence adapter. Business code retains its state shape; unchanged entities are never rewritten.
 * Historical state hydration is intentionally separate from paginated client reads. */
export class StateRepository {
  private cached = new Map<string, string>();
  private storage: StateStorage;
  constructor(storage: StateStorage) {
    this.storage=storage;
    storage.transactionSync(() => {
      storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_app_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)");
      const version = storage.sql.exec<{ version: number }>("SELECT version FROM pra_app_schema WHERE id=1").toArray()[0]?.version ?? 0;
      if (version > 1) throw new Problem("UNKNOWN_STATE_SCHEMA", 503);
      storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_meta (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      for (const name of collections) {
        storage.sql.exec("CREATE TABLE IF NOT EXISTS " + table(name) + " (id TEXT PRIMARY KEY, parent TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL)");
        storage.sql.exec("CREATE INDEX IF NOT EXISTS " + table(name) + "_parent ON " + table(name) + "(parent,id)");
      }
      storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, value TEXT NOT NULL)");
      if (version === 0) {
        const legacy = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='pra_state'").toArray().length > 0;
        if (legacy) {
          const old = storage.sql.exec<{ value: string }>("SELECT value FROM pra_state WHERE id=1").toArray()[0];
          if (old) {
            const state = parse<State>(old.value);
            if (!Array.isArray(state.tasks) || !Array.isArray(state.operations) || !state.usage) throw new Problem("INVALID_LEGACY_STATE", 503);
            const split = this.split(state);
            for (const [name, rows] of split.rows)
              for (const row of rows) this.put(name, row);
            for (const [id, value] of split.meta) storage.sql.exec("INSERT INTO pra_meta VALUES(?,?)", id, value);
            // Compare reconstructed data before removing the former source of truth.
            const restored = this.read();
            if (serial([...this.fingerprints(this.split(restored))].sort()) !== serial([...this.fingerprints(split)].sort())) throw new Problem("STATE_MIGRATION_MISMATCH", 503);
          }
          storage.sql.exec("DROP TABLE pra_state");
        }
        storage.sql.exec("INSERT INTO pra_meta(id,value) VALUES('usage',?) ON CONFLICT(id) DO NOTHING", serial(initialState().usage));
        storage.sql.exec("INSERT INTO pra_app_schema VALUES(1,1)");
      }
    });
  }
  private put(name: Collection, row: Row) {
    this.storage.sql.exec("INSERT INTO " + table(name) + "(id,parent,position,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,position=excluded.position,value=excluded.value",
      row.id, row.parent, row.position, row.value);
  }
  private split(state: State) {
    const meta = new Map<string, string>(), rows = new Map<Collection, Row[]>();
    const rest: Record<string, any> = { ...state };
    const add = (name: Collection, values: any[], idOf = (v: any) => String(v.id), parentOf = (v: any) => String(v.conversationId ?? v.taskId ?? "")) => {
      const ids = new Set<string>();
      rows.set(name, values.map((v, position) => {
        const id = idOf(v);
        if (!id || ids.has(id)) throw new Problem("DUPLICATE_STATE_ID", 409);
        ids.add(id);
        return { id, parent: parentOf(v), position, value: serial(v) };
      }));
    };
    for (const name of ["tasks", "operations", "memories", "notices", "plans"] as const) { add(name, state[name]); delete rest[name]; }
    add("papers", Object.entries(state.papers).map(([key, paper]) => ({ key, paper })), v => v.key, () => "");
    delete rest.papers;
    if (state.conversations) {
      add("conversations", state.conversations.map(({ history, ...c }) => c));
      add("messages", state.conversations.flatMap(c => c.history.map((message, position) => ({ conversationId: c.id, position, message }))),
        v => JSON.stringify([v.conversationId, v.message.turn_id]), v => v.conversationId);
      delete rest.conversations;
      meta.set("has_conversations", "true");
    } else { rows.set("conversations", []); rows.set("messages", []); }
    if (state.cloudMemory) {
      add("memory_entries", state.cloudMemory.entries, v => v.id, v => v.source_session ?? "");
      rest.cloudMemory = { ...state.cloudMemory, entries: [] };
    } else rows.set("memory_entries", []);
    // Separate usage and memory settings so normal execution does not rewrite unrelated metadata.
    for (const [key, value] of Object.entries(rest)) if (value !== undefined) meta.set(key, serial(value));
    return { meta, rows };
  }
  private read(): State {
    const state: any = initialState();
    for (const row of this.storage.sql.exec<{ id: string; value: string }>("SELECT id,value FROM pra_meta").toArray()) state[row.id] = parse(row.value);
    const all = (name: Collection) => this.storage.sql.exec<Row>("SELECT * FROM " + table(name) + " ORDER BY position,id").toArray().map(row => parse<any>(row.value));
    for (const name of ["tasks", "operations", "memories", "notices", "plans"] as const) state[name] = all(name);
    state.papers = Object.fromEntries(all("papers").map(v => [v.key, v.paper]));
    if (state.has_conversations) {
      const messages = all("messages");
      state.conversations = all("conversations").map(c => ({ ...c, history: messages.filter(m => m.conversationId === c.id).sort((a,b) => a.position-b.position).map(m => m.message) }));
    }
    delete state.has_conversations;
    if (state.cloudMemory) state.cloudMemory.entries = all("memory_entries");
    return state;
  }
  load(): State {
    const state = this.read();
    this.cached = this.fingerprints(this.split(state));
    return state;
  }
  private fingerprints(split: ReturnType<StateRepository["split"]>) {
    const cache = new Map<string, string>();
    for (const [key, value] of split.meta) cache.set("meta:" + key, value);
    for (const [name, rows] of split.rows) for (const row of rows) cache.set(name + ":" + row.id, serial(row));
    return cache;
  }
  save(state: State): { writes: number; cursor: number } {
    const split = this.split(state), next = this.fingerprints(split), changes: Array<{ entity: string; id: string; deleted?: true }> = [];
    this.storage.transactionSync(() => {
      for (const [key, value] of split.meta) if (this.cached.get("meta:" + key) !== value) {
        this.storage.sql.exec("INSERT INTO pra_meta VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", key, value);
        changes.push({ entity: "meta", id: key });
      }
      for (const [name, rows] of split.rows) for (const row of rows) if (this.cached.get(name + ":" + row.id) !== serial(row)) {
        this.put(name, row); changes.push({ entity: name, id: row.id });
      }
      for (const key of this.cached.keys()) if (!next.has(key)) {
        const at = key.indexOf(":"), name = key.slice(0, at), id = key.slice(at + 1);
        if (name === "meta") this.storage.sql.exec("DELETE FROM pra_meta WHERE id=?", id);
        else if (validCollection(name)) this.storage.sql.exec("DELETE FROM " + table(name) + " WHERE id=?", id);
        changes.push({ entity: name, id, deleted: true });
      }
      // Invalidation events contain identifiers only, never prompts or copies of deleted content.
      if (changes.length) this.storage.sql.exec("INSERT INTO pra_changes(created,value) VALUES(?,?)", Date.now(), serial(changes));
    });
    // Never advance the cache if the transaction failed.
    this.cached = next;
    return { writes: changes.length, cursor: this.cursor() };
  }
  cursor() { return this.storage.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM pra_changes").toArray()[0].seq; }
  changes(after = 0, limit = 100) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Problem("INVALID_CURSOR");
    const rows = this.storage.sql.exec<{ seq: number; created: number; value: string }>("SELECT seq,created,value FROM pra_changes WHERE seq>? ORDER BY seq LIMIT ?", after, limit).toArray();
    return { events: rows.map(({ value, ...r }) => ({ ...r, changes: parse(value) })), cursor: rows.at(-1)?.seq ?? after, latest: this.cursor() };
  }
  page(name: string, after = "", limit = 50, parent?: string) {
    if (!validCollection(name) || !Number.isInteger(limit) || limit < 1 || limit > 100 || after.length > 1024) throw new Problem("INVALID_PAGE");
    const rows = this.storage.sql.exec<Row>("SELECT * FROM " + table(name) + " WHERE id>?" + (parent !== undefined ? " AND parent=?" : "") + " ORDER BY id LIMIT ?",
      after, ...(parent !== undefined ? [parent] : []), limit + 1).toArray();
    const page = rows.slice(0, limit);
    return { items: page.map(row => parse<any>(row.value)), nextCursor: rows.length > limit ? page.at(-1)!.id : null };
  }
}
