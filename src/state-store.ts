import {Buffer} from "node:buffer";
import {bindDialogueStorage, recentResearchDialogue, RESEARCH_HISTORY_TURNS, type ResearchDialogue} from "../packages/research/context-window.ts";
import {memoryView} from "./memory-view.ts";
import {bindTaskQueries,closedTask,matchesTaskPage,taskPageOrder,type TaskPageQuery} from "./task-queries.ts";
import {entityHeader,isLazyCollection,lazyEntity,type LazyEntity,type LazyCollection} from "./lazy-entity.ts";
import { stableEntityPositions } from "./row-order.ts";
import { appendChanges, changeCursor, initializeChangeFeed, readChanges } from "./change-feed.ts";
import { initialState, Problem, type State, type Task } from "./domain.ts";

export interface SqlRows<T = Record<string, unknown>> { toArray(): T[] }
export interface SqlPort {
  exec<T = Record<string, unknown>>(query: string, ...bindings: any[]): SqlRows<T>;
}
export interface StateStorage { sql: SqlPort; transactionSync<T>(fn: () => T): T }
const collections = ["tasks", "operations", "memories", "notices", "plans", "papers", "conversations", "messages", "memory_entries"] as const;
export type Collection = (typeof collections)[number];
type Conversation = NonNullable<State["conversations"]>[number];
interface HistoryPartition {
  conversation: Conversation;
  loaded: boolean;
  value: Conversation["history"];
  base?: number;
  pending?: Map<string, Conversation["history"][number]>;
  dialogue?: {excludedKeys: string; window: ResearchDialogue};
}
interface Row { id: string; parent: string; position: number; value: string }
const table = (name: Collection) => "pra_data_" + name;
const serial = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: string): T => JSON.parse(v);
const validCollection = (name: string): name is Collection => collections.includes(name as Collection);

/** SQL persistence adapter. Business code retains its state shape; unchanged entities are never rewritten.
 * Historical state hydration is intentionally separate from paginated client reads. */
export class StateRepository {
  private canonicalMemory=false;
  private cached = new Map<string, string>();
  private entities = new WeakMap<object,LazyEntity>();
  private positions = new Map<Collection, Map<string, number>>();
  private storage: StateStorage;
  private histories = new Map<string, HistoryPartition>();
  private overviewWindows = new WeakMap<State, {times: Map<string, number>; floor: number}>();
  private historyCounts = new Map<string, number>();
  private knownConversations = new Set<string>();
  private messageParents = new Map<string, string>();
  constructor(storage: StateStorage) {
    this.storage=storage;
    storage.transactionSync(() => {
      storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_app_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)");
      const version = storage.sql.exec<{ version: number }>("SELECT version FROM pra_app_schema WHERE id=1").toArray()[0]?.version ?? 0;
      if (version > 4) throw new Problem("UNKNOWN_STATE_SCHEMA", 503);
      storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_meta (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      for (const name of collections) {
        storage.sql.exec("CREATE TABLE IF NOT EXISTS " + table(name) + " (id TEXT PRIMARY KEY, parent TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL)");
        storage.sql.exec("CREATE INDEX IF NOT EXISTS " + table(name) + "_parent ON " + table(name) + "(parent,id)");
      }
      for(const name of ["tasks","operations","memory_entries"] as const){
        const columns=storage.sql.exec<{name:string}>("PRAGMA table_info("+table(name)+")").toArray();
        if(!columns.some(c=>c.name==="header")){
          if(version>=(name==="memory_entries"?4:3))throw new Problem("INVALID_ENTITY_HEADER",503);
          storage.sql.exec("ALTER TABLE "+table(name)+" ADD COLUMN header TEXT");
        }
      }
      storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_history_counts (conversation_id TEXT PRIMARY KEY, turns INTEGER NOT NULL CHECK(turns>=0))");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_messages_position ON pra_data_messages(parent,position,id)");
      initializeChangeFeed(storage);
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
      if (version < 2) {
        storage.sql.exec("INSERT OR REPLACE INTO pra_history_counts SELECT c.id,COUNT(m.id) FROM pra_data_conversations c LEFT JOIN pra_data_messages m ON m.parent=c.id GROUP BY c.id");
        storage.sql.exec("UPDATE pra_app_schema SET version=2 WHERE id=1");
      }
      if(version<3){
        for(const name of ["tasks","operations"] as const){
          let after="";
          for(;;){
            const rows=storage.sql.exec<Row>("SELECT id,parent,position,value FROM "+table(name)+" WHERE id>? ORDER BY id LIMIT 200",after).toArray();
            if(!rows.length)break;
            for(const row of rows)storage.sql.exec("UPDATE "+table(name)+" SET header=? WHERE id=?",serial(entityHeader(name,parse(row.value))),row.id);
            after=rows.at(-1)!.id;
          }
        }
        storage.sql.exec("UPDATE pra_app_schema SET version=3 WHERE id=1");
      }
      if(version<4){
        let after="";
        for(;;){
          const rows=storage.sql.exec<Row>("SELECT id,parent,position,value FROM pra_data_memory_entries WHERE id>? ORDER BY id LIMIT 200",after).toArray();
          if(!rows.length)break;
          for(const row of rows)storage.sql.exec("UPDATE pra_data_memory_entries SET header=? WHERE id=?",serial(entityHeader("memory_entries",parse(row.value))),row.id);
          after=rows.at(-1)!.id;
        }
        const memoryMeta=storage.sql.exec<{value:string}>("SELECT value FROM pra_meta WHERE id='cloudMemory'").toArray()[0];
        if(memoryMeta){const memory=parse<any>(memoryMeta.value);if(!memory||!Array.isArray(memory.entries)||typeof memory.enabled!=="boolean")throw new Problem("INVALID_MEMORY_STATE",503);storage.sql.exec("DELETE FROM pra_data_memories");}
        storage.sql.exec("UPDATE pra_app_schema SET version=4 WHERE id=1");
      }
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_tasks_request ON pra_data_tasks(json_extract(header,'$.requestId'))");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_tasks_created ON pra_data_tasks(json_extract(header,'$.created') DESC,id DESC)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_tasks_conversation_created ON pra_data_tasks(parent,json_extract(header,'$.created') DESC,id DESC)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_tasks_status_created ON pra_data_tasks(json_extract(header,'$.status'),json_extract(header,'$.created') DESC,id DESC)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_tasks_active ON pra_data_tasks(id) WHERE json_extract(header,'$.status') NOT IN ('completed','failed','cancelled')");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_tasks_open ON pra_data_tasks(id) WHERE json_extract(header,'$.status') NOT IN ('completed','failed','cancelled') OR json_extract(header,'$.runOpen')=1");
    });
    this.canonicalMemory=true;
  }
  private put(name: Collection, row: Row) {
    if(isLazyCollection(name)){
      this.storage.sql.exec("INSERT INTO "+table(name)+"(id,parent,position,value,header) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,position=excluded.position,value=excluded.value,header=excluded.header",row.id,row.parent,row.position,row.value,serial(entityHeader(name,parse(row.value))));
      return;
    }
    this.storage.sql.exec("INSERT INTO " + table(name) + "(id,parent,position,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,position=excluded.position,value=excluded.value",
      row.id, row.parent, row.position, row.value);
  }
  private split(state: State) {
    const meta = new Map<string, string>(), rows = new Map<Collection, Row[]>(), untouched = new Set<string>(), counts = new Map<string,number>();
    const rest: Record<string, any> = { ...state };
    const add = (name: Collection, values: any[], idOf = (v: any) => String(v.id), parentOf = (v: any) => String(name==="tasks"?(v.conversationId??""):name==="operations"?(v.taskId??""):(v.conversationId??v.taskId??"")), positionOf?: (v:any,position:number)=>number) => {
      const ids = new Set<string>(), identities = values.map(idOf);
      const positions = positionOf ? undefined : stableEntityPositions(identities, this.positions.get(name) ?? new Map());
      rows.set(name, values.map((v, position) => {
        const id = identities[position];
        if (!id || ids.has(id)) throw new Problem("DUPLICATE_STATE_ID", 409);
        ids.add(id);
        const savedPosition=positionOf?.(v,position)??positions![position],entity=isLazyCollection(name)?this.entities.get(v):undefined;
        if(entity&&!entity.loaded&&entity.position!==savedPosition)entity.load();
        return { id, parent: entity&&!entity.loaded?entity.parent??parentOf(v):parentOf(v), position:savedPosition, value:entity&&!entity.loaded?"":serial(v) };
      }));
    };
    for (const name of ["tasks", "operations", "memories", "notices", "plans"] as const) { add(name, name==="memories"&&this.canonicalMemory&&state.cloudMemory?[]:state[name]); delete rest[name]; }
    add("papers", Object.entries(state.papers).map(([key, paper]) => ({ key, paper })), v => v.key, () => "");
    delete rest.papers;
    if (state.conversations) {
      add("conversations", state.conversations.map(c => Object.fromEntries(Object.keys(c).filter(k=>k!=="history").map(k=>[k,(c as any)[k]]))));
      const messages:any[]=[];
      for(const c of state.conversations){
        const partition=this.histories.get(c.id);
        if (partition?.conversation === c && !partition.loaded) {
          untouched.add(c.id);
          if (partition.pending?.size) {
            let position = this.historyCounts.get(c.id) ?? 0;
            for (const message of partition.pending.values()) messages.push({conversationId:c.id, position:position++, message});
            counts.set(c.id, position);
          }
          continue;
        }
        // Replacing an unloaded conversation must still remove its old turns.
        if(partition&&!partition.loaded)this.loadHistory(partition);
        counts.set(c.id,c.history.length);
        messages.push(...c.history.map((message,position)=>({conversationId:c.id,position,message})));
      }
      add("messages",messages,v=>JSON.stringify([v.conversationId,v.message.turn_id]),v=>v.conversationId,
        v=>(this.histories.get(v.conversationId)?.base??0)+v.position);
      delete rest.conversations;
      meta.set("has_conversations", "true");
    } else { rows.set("conversations", []); rows.set("messages", []); }
    if (state.cloudMemory) {
      add("memory_entries", state.cloudMemory.entries, v => v.id, v => v.source_session ?? "");
      rest.cloudMemory = { ...state.cloudMemory, entries: [] };
    } else rows.set("memory_entries", []);
    // Separate usage and memory settings so normal execution does not rewrite unrelated metadata.
    for (const [key, value] of Object.entries(rest)) if (value !== undefined) meta.set(key, serial(value));
    return { meta, rows, untouched, counts };
  }
  private loadHistory(partition:HistoryPartition):Conversation["history"] {
    if(!partition.loaded){
      const rows=this.storage.sql.exec<Row>("SELECT * FROM pra_data_messages WHERE parent=? ORDER BY position,id",partition.conversation.id).toArray();
      const values=rows.map(row=>parse<any>(row.value));
      partition.base=rows.length?rows[0].position-values[0].position:0;
      partition.value=values.sort((a,b)=>a.position-b.position).map(v=>v.message);
      for(const row of rows){const key="messages:"+row.id;this.cached.set(key,serial(row));this.messageParents.set(key,row.parent);}
      if (partition.pending) partition.value.push(...partition.pending.values());
      delete partition.pending;
      delete partition.dialogue;
      partition.loaded=true;
    }
    return partition.value;
  }
  historyCount(conversation:Conversation){
    const partition=this.histories.get(conversation.id);
    return partition?.conversation === conversation && !partition.loaded
      ? (this.historyCounts.get(conversation.id) ?? 0) + (partition.pending?.size ?? 0)
      : conversation.history.length;
  }
  researchDialogue(conversation: Conversation, invalidated: readonly string[] = []): ResearchDialogue {
    const partition = this.histories.get(conversation.id);
    if (!partition || partition.conversation !== conversation || partition.loaded)
      return recentResearchDialogue(conversation.history, invalidated);

    const ids = Array.from(new Set(invalidated), turn => JSON.stringify([conversation.id, turn]));
    const excludedKeys = JSON.stringify(ids);
    if (partition.dialogue?.excludedKeys !== excludedKeys) {
      const excluded = ids.length ? this.storage.sql.exec<{n:number}>(
        "SELECT COUNT(*) AS n FROM json_each(?) revoked CROSS JOIN pra_data_messages m WHERE m.id=revoked.value",
        excludedKeys,
      ).toArray()[0].n : 0;
      const filter = excluded ? " AND id NOT IN (SELECT value FROM json_each(?))" : "";
      const rows = this.storage.sql.exec<{value:string}>(
        "SELECT value FROM pra_data_messages WHERE parent=?" + filter + " ORDER BY position DESC,id DESC LIMIT ?",
        conversation.id, ...(excluded ? [excludedKeys] : []), RESEARCH_HISTORY_TURNS,
      ).toArray();
      const recent = rows.reverse().map(row => parse<{message:Conversation["history"][number]}>(row.value).message);
      partition.dialogue = {excludedKeys, window:{stored:this.historyCounts.get(conversation.id) ?? 0, excluded, recent}};
    }
    const saved = partition.dialogue.window;
    if (!partition.pending?.size) return saved;
    const pending = recentResearchDialogue([...partition.pending.values()], invalidated);
    return {stored:saved.stored + pending.stored, excluded:saved.excluded + pending.excluded,
      recent:[...saved.recent, ...pending.recent].slice(-RESEARCH_HISTORY_TURNS)};
  }
  /** Stage new turns for the same transaction as task state and change events. */
  private stageDialogueTurn(partition: HistoryPartition, turn: Conversation["history"][number]) {
    const id = partition.conversation.id;
    if (partition.loaded || this.histories.get(id) !== partition) return false;
    const pending = partition.pending ??= new Map();
    if (!pending.delete(turn.turn_id)) {
      const key = JSON.stringify([id, turn.turn_id]);
      const old = this.storage.sql.exec<{value:string}>("SELECT value FROM pra_data_messages WHERE id=?", key).toArray()[0];
      if (old) {
        const saved = parse<{position:number; message:Conversation["history"][number]}>(old.value);
        // A changed or reordered historical turn keeps the original full-array replacement semantics.
        return !pending.size && saved.position === (this.historyCounts.get(id) ?? 0) - 1 && serial(saved.message) === serial(turn);
      }
    }
    if (partition.base === undefined) {
      const first = this.storage.sql.exec<{base:number}>(
        "SELECT position - json_extract(value,'$.position') AS base FROM pra_data_messages WHERE parent=? ORDER BY position,id LIMIT 1", id,
      ).toArray()[0];
      partition.base = first?.base ?? 0;
    }
    pending.set(turn.turn_id, turn);
    return true;
  }
  private attachHistory(conversation:Conversation){
    const partition:HistoryPartition={conversation,loaded:false,value:[]};
    this.histories.set(conversation.id,partition);
    bindDialogueStorage(conversation,{read: invalidated => this.researchDialogue(conversation, invalidated),
      stage: turn => this.stageDialogueTurn(partition, turn)});
    Object.defineProperty(conversation,"history",{enumerable:true,configurable:true,
      get:()=>this.loadHistory(partition),
      set:(value:Conversation["history"])=>{if(!Array.isArray(value))throw new Problem("INVALID_HISTORY");this.loadHistory(partition);partition.value=value;}
    });
    return conversation;
  }
  private attachEntity(name:LazyCollection,row:{id:string;parent:string;position:number;header?:string}){
    const knownHeader=row.header===undefined?undefined:parse<Record<string,any>>(row.header);
    if(row.header!==undefined&&(!knownHeader||knownHeader.id!==row.id))throw new Problem("INVALID_ENTITY_HEADER",503);
    const entity=lazyEntity(name,knownHeader??{id:row.id},row.position,()=>{
      const stored=this.storage.sql.exec<Row>("SELECT id,parent,position,value FROM "+table(name)+" WHERE id=?",row.id).toArray()[0];
      if(!stored)throw new Problem("ENTITY_UNAVAILABLE",503);
      // Cache the original persisted bytes before exposing a mutable payload.
      this.cached.set(name+":"+row.id,serial(stored));
      return parse<Record<string,any>>(stored.value);
    },knownHeader?undefined:()=>{
      const stored=this.storage.sql.exec<{header:string}>("SELECT header FROM "+table(name)+" WHERE id=?",row.id).toArray()[0];
      const header=stored&&parse<Record<string,any>>(stored.header);
      if(!header||header.id!==row.id)throw new Problem("INVALID_ENTITY_HEADER",503);
      return header;
    });
    entity.parent=row.parent;this.entities.set(entity.proxy,entity);return entity.proxy;
  }
  private read(lazy=false): State {
    const state: any = initialState();
    for (const row of this.storage.sql.exec<{ id: string; value: string }>("SELECT id,value FROM pra_meta").toArray()) state[row.id] = parse(row.value);
    const all = (name: Collection) => {
      if(lazy&&isLazyCollection(name)){
        const rows=this.storage.sql.exec<{id:string;parent:string;position:number;header?:string}>("SELECT id,parent,position"+(name==="memory_entries"?",header":"")+" FROM "+table(name)).toArray();
        // These rows are already needed in memory. Preserve SQLite's BINARY tie order without a temporary table.
        rows.sort((a,b)=>a.position-b.position || Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
        this.positions.set(name,new Map(rows.map(row=>[row.id,row.position])));
        return rows.map(row=>this.attachEntity(name,row));
      }
      const rows = this.storage.sql.exec<Row>("SELECT id,parent,position,value FROM " + table(name) + " ORDER BY position,id").toArray();
      if (name !== "messages") this.positions.set(name, new Map(rows.map(row => [row.id, row.position])));
      return rows.map(row => parse<any>(row.value));
    };
    for (const name of ["tasks", "operations", "memories", "notices", "plans"] as const) state[name] = all(name);
    state.papers = Object.fromEntries(all("papers").map(v => [v.key, v.paper]));
    if (state.has_conversations) {
      const conversations=all("conversations");
      if(lazy)state.conversations=conversations.map(c=>this.attachHistory(c));
      else{
        const messages=all("messages"),byConversation=new Map<string,any[]>();
        for(const message of messages){const values=byConversation.get(message.conversationId)??[];values.push(message);byConversation.set(message.conversationId,values);}
        state.conversations=conversations.map(c=>({...c,history:(byConversation.get(c.id)??[]).sort((a,b)=>a.position-b.position).map(m=>m.message)}));
      }
    }
    delete state.has_conversations;
    if (state.cloudMemory) {state.cloudMemory.entries = all("memory_entries");if(this.canonicalMemory)state.memories=memoryView(state.cloudMemory.entries); }
    return state;
  }
  load(): State {
    this.entities=new WeakMap();this.histories.clear();this.cached.clear();this.messageParents.clear();this.positions.clear();
    this.historyCounts=new Map(this.storage.sql.exec<{conversation_id:string;turns:number}>("SELECT conversation_id,turns FROM pra_history_counts").toArray().map(r=>[r.conversation_id,r.turns]));
    const state = this.read(true);
    this.knownConversations=new Set((state.conversations??[]).map(c=>c.id));
    this.cached = this.fingerprints(this.split(state));
    const persistedActive = new Map<boolean, Set<string>>();
    bindTaskQueries(state,{
      recentOverview:limit=>this.recentOverviewRows(state,limit), page:query=>this.taskPageRows(state,query),
      active:includeOpen=>this.activeTaskRows(state,includeOpen,persistedActive), byRequest:requestId=>this.taskRequest(state,requestId),
    });
    return state;
  }
  /** Loaded/new values are authoritative until save; SQL is only used for untouched entities. */
  private taskOverlay(state:State){
    const saved=new Map<string,Task>(),overlay:Task[]=[];
    for(const task of state.tasks){const entity=this.entities.get(task);if(entity&&!entity.loaded)saved.set(task.id,task);else overlay.push(task);}
    return {saved,overlay};
  }
  private taskRequest(state:State,requestId:string):Task|undefined{
    const {saved,overlay}=this.taskOverlay(state),ids=new Set(overlay.filter(t=>t.requestId===requestId).map(t=>t.id));
    if(saved.size)for(const row of this.storage.sql.exec<{id:string}>("SELECT id FROM pra_data_tasks WHERE json_extract(header,'$.requestId')=?",requestId).toArray())if(saved.has(row.id))ids.add(row.id);
    return state.tasks.find(t=>ids.has(t.id));
  }
  private storedTaskPage(saved: Map<string,Task>, query: TaskPageQuery, projectChats?: string[], createdById?: Map<string,number>): Task[] {
    const where: string[] = [], args: string[] = [];
    const single = query.conversationId ?? (projectChats?.length === 1 ? projectChats[0] : undefined);
    if(single){where.push("parent=?");args.push(single);}
    else if(projectChats){where.push("parent IN (SELECT value FROM json_each(?))");args.push(JSON.stringify(projectChats));}
    if(query.status){where.push("json_extract(header,'$.status')=?");args.push(query.status);}
    const table = projectChats ? "pra_data_tasks INDEXED BY pra_tasks_conversation_created" : "pra_data_tasks";
    const select=(condition:string,bindings:unknown[],limit:number,sameTime=false)=>
      this.storage.sql.exec<{id:string;created:number}>(
        "SELECT id,json_extract(header,'$.created') AS created FROM "+table+" WHERE "+[condition,...where].join(" AND ")+
        " ORDER BY "+(sameTime?"id DESC":"json_extract(header,'$.created') DESC,id DESC")+" LIMIT ?",
        ...bindings,...args,limit,
      ).toArray();
    const selected: Task[] = [];
    let timestamp=query.timestamp,id=query.id;
    while(saved.size && selected.length<query.limit+1){
      // Separate equal-time and older ranges to keep both index seeks bounded.
      const needed=query.limit+1-selected.length;
      const rows=select("json_extract(header,'$.created')=? AND id<?",[timestamp,id],needed,true);
      if(rows.length<needed)rows.push(...select("json_extract(header,'$.created')<?",[timestamp],needed-rows.length));
      for (const row of rows) {
        const task = saved.get(row.id);
        if (task) { selected.push(task); createdById?.set(row.id, row.created); }
      }
      if(rows.length<needed)break;
      const last=rows.at(-1)!;timestamp=last.created;id=last.id;
    }
    return selected;
  }
  private recentOverviewRows(state: State, limit: number): Task[] {
    const {saved} = this.taskOverlay(state);
    const time = (task: Task, known: ReadonlyMap<string, number>) =>
      saved.has(task.id) ? known.get(task.id)! : task.created;
    const select = (known: ReadonlyMap<string, number>) => state.tasks
      .filter(task => !saved.has(task.id) || known.has(task.id))
      .sort((a, b) => time(b, known) - time(a, known)).slice(0, limit);

    const previous = this.overviewWindows.get(state);
    if (previous) {
      const items = select(previous.times);
      if (previous.floor === -Infinity || (items.length === limit && time(items[limit - 1], previous.times) >= previous.floor)) return items;
    }

    const times = new Map<string, number>();
    const rows = this.storedTaskPage(saved, {limit, timestamp: Number.MAX_SAFE_INTEGER, id: "~"}, undefined, times);
    const extra = rows[limit];
    const floor = extra ? times.get(rows[limit - 1].id)! : -Infinity;
    if (extra && times.get(extra.id) === floor) {
      // The homepage keeps collection order for ties. Include every ID at the cutoff without loading their bodies.
      for (const row of this.storage.sql.exec<{id: string}>(
        "SELECT id FROM pra_data_tasks WHERE json_extract(header,'$.created')=?", floor,
      ).toArray()) if (saved.has(row.id)) times.set(row.id, floor);
    }
    this.overviewWindows.set(state, {times, floor});
    return select(times);
  }
  private taskPageRows(state:State,query:TaskPageQuery):Task[]{
    const {saved,overlay}=this.taskOverlay(state);
    const selected=overlay.filter(t=>matchesTaskPage(t,query));
    if(query.projectConversations && !query.conversationId){
      // Each group supplies at most one page, independent of the total number of projects.
      const chats=[...query.projectConversations];
      for(let i=0;i<chats.length;i+=128)selected.push(...this.storedTaskPage(saved,query,chats.slice(i,i+128)));
    }else selected.push(...this.storedTaskPage(saved,query));
    return selected.sort(taskPageOrder).slice(0,query.limit+1);
  }
  private persistedActiveIds(includeOpen: boolean): Set<string> {
    const predicate = "json_extract(header,'$.status') NOT IN ('completed','failed','cancelled')" +
      (includeOpen ? " OR json_extract(header,'$.runOpen')=1" : "");
    const ids = new Set<string>();
    let after = "";
    for (;;) {
      const rows = this.storage.sql.exec<{id: string}>(
        "SELECT id FROM pra_data_tasks WHERE ("+predicate+") AND id>? ORDER BY id LIMIT 200", after,
      ).toArray();
      for (const row of rows) ids.add(row.id);
      if (rows.length < 200) return ids;
      after = rows[rows.length - 1].id;
    }
  }
  private activeTaskRows(state: State, includeOpen: boolean, persisted: Map<boolean, Set<string>>): Task[] {
    let ids = persisted.get(includeOpen);
    return state.tasks.filter(task => {
      // A write hydrates its entity. New and edited tasks always use their current state.
      if (this.entities.get(task)?.loaded !== false) return !closedTask(task) || (includeOpen && task.runOpen);
      if (!ids) {
        ids = this.persistedActiveIds(includeOpen);
        persisted.set(includeOpen, ids);
      }
      return ids.has(task.id);
    });
  }
  private fingerprints(split: ReturnType<StateRepository["split"]>) {
    const cache = new Map<string, string>();
    for (const [key, value] of split.meta) cache.set("meta:" + key, value);
    for (const [name, rows] of split.rows) for (const row of rows) cache.set(name + ":" + row.id, serial(row));
    return cache;
  }
  save(state: State): { writes: number; cursor: number } {
    const split = this.split(state), next = this.fingerprints(split), changes: Array<{ entity: string; id: string; deleted?: true }> = [];
    for(const [key,parent] of this.messageParents)if(split.untouched.has(parent)&&this.cached.has(key))next.set(key,this.cached.get(key)!);
    const conversationIds=new Set((split.rows.get("conversations")??[]).map(c=>c.id));
    const removed=[...this.knownConversations].filter(id=>!conversationIds.has(id)),deletedMessages=new Set<string>();
    this.storage.transactionSync(() => {
      for(const id of removed){
        for(const row of this.storage.sql.exec<{id:string}>("SELECT id FROM pra_data_messages WHERE parent=?",id).toArray()){
          deletedMessages.add("messages:"+row.id);changes.push({entity:"messages",id:row.id,deleted:true});
        }
        this.storage.sql.exec("DELETE FROM pra_data_messages WHERE parent=?",id);
        this.storage.sql.exec("DELETE FROM pra_history_counts WHERE conversation_id=?",id);
      }
      for(const [id,turns] of split.counts)if(this.historyCounts.get(id)!==turns)
        this.storage.sql.exec("INSERT INTO pra_history_counts VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET turns=excluded.turns",id,turns);
      for (const [key, value] of split.meta) if (this.cached.get("meta:" + key) !== value) {
        this.storage.sql.exec("INSERT INTO pra_meta VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", key, value);
        changes.push({ entity: "meta", id: key });
      }
      for (const [name, rows] of split.rows) for (const row of rows) if (this.cached.get(name + ":" + row.id) !== serial(row)) {
        if(!row.value)throw new Problem("UNLOADED_ENTITY_WRITE",503);
        this.put(name, row); changes.push({ entity: name, id: row.id });
      }
      for (const key of this.cached.keys()) if (!next.has(key)&&!deletedMessages.has(key)) {
        const at = key.indexOf(":"), name = key.slice(0, at), id = key.slice(at + 1);
        if (name === "meta") this.storage.sql.exec("DELETE FROM pra_meta WHERE id=?", id);
        else if (validCollection(name)) this.storage.sql.exec("DELETE FROM " + table(name) + " WHERE id=?", id);
        changes.push({ entity: name, id, deleted: true });
      }
      // Invalidation events contain identifiers only, never prompts or copies of deleted content.
      if (changes.length) appendChanges(this.storage, changes);
    });
    // Never advance the cache if the transaction failed.
    this.cached = next;
    for (const [name, rows] of split.rows) if (name !== "messages")
      this.positions.set(name, new Map(rows.map(row => [row.id, row.position])));
    for(const id of removed){this.histories.delete(id);this.historyCounts.delete(id);}
    for (const [id,count] of split.counts) {
      this.historyCounts.set(id,count);
      const partition = this.histories.get(id);
      if (partition?.pending?.size) {
        delete partition.pending;
        delete partition.dialogue;
      }
    }
    for(const row of split.rows.get("messages")??[])this.messageParents.set("messages:"+row.id,row.parent);
    for(const key of this.messageParents.keys())if(!next.has(key))this.messageParents.delete(key);
    this.knownConversations=conversationIds;
    return { writes: changes.length, cursor: this.cursor() };
  }
  cursor() { return changeCursor(this.storage); }
  changes(after = 0, limit = 100) { return readChanges(this.storage, after, limit); }
  page(name: string, after = "", limit = 50, parent?: string) {
    if (!validCollection(name) || !Number.isInteger(limit) || limit < 1 || limit > 100 || after.length > 1024) throw new Problem("INVALID_PAGE");
    const rows = this.storage.sql.exec<Row>("SELECT * FROM " + table(name) + " WHERE id>?" + (parent !== undefined ? " AND parent=?" : "") + " ORDER BY id LIMIT ?",
      after, ...(parent !== undefined ? [parent] : []), limit + 1).toArray();
    const page = rows.slice(0, limit);
    return { items: page.map(row => parse<any>(row.value)), nextCursor: rows.length > limit ? page.at(-1)!.id : null };
  }
}
