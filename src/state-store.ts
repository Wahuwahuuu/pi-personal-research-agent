import {bindTaskQueries,closedTask,matchesTaskPage,taskPageOrder,type TaskPageQuery} from "./task-queries.ts";
import {entityHeader,isLazyCollection,lazyEntity,type LazyEntity,type LazyCollection} from "./lazy-entity.ts";
import { stableEntityPositions } from "./row-order.ts";
import { appendChanges, changeCursor, readChanges } from "./change-feed.ts";
import { initialState, Problem, type State, type Task } from "./domain.ts";

export interface SqlRows<T = Record<string, unknown>> { toArray(): T[] }
export interface SqlPort {
  exec<T = Record<string, unknown>>(query: string, ...bindings: any[]): SqlRows<T>;
}
export interface StateStorage { sql: SqlPort; transactionSync<T>(fn: () => T): T }
const collections = ["tasks", "operations", "memories", "notices", "plans", "papers", "conversations", "messages", "memory_entries"] as const;
export type Collection = (typeof collections)[number];
type Conversation = NonNullable<State["conversations"]>[number];
interface HistoryPartition {conversation:Conversation;loaded:boolean;value:Conversation["history"];base:number}
interface Row { id: string; parent: string; position: number; value: string }
const table = (name: Collection) => "pra_data_" + name;
const serial = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: string): T => JSON.parse(v);
const validCollection = (name: string): name is Collection => collections.includes(name as Collection);

/** SQL persistence adapter. Business code retains its state shape; unchanged entities are never rewritten.
 * Historical state hydration is intentionally separate from paginated client reads. */
export class StateRepository {
  private cached = new Map<string, string>();
  private entities = new WeakMap<object,LazyEntity>();
  private positions = new Map<Collection, Map<string, number>>();
  private storage: StateStorage;
  private histories = new Map<string, HistoryPartition>();
  private historyCounts = new Map<string, number>();
  private knownConversations = new Set<string>();
  private messageParents = new Map<string, string>();
  constructor(storage: StateStorage) {
    this.storage=storage;
    storage.transactionSync(() => {
      storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_app_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)");
      const version = storage.sql.exec<{ version: number }>("SELECT version FROM pra_app_schema WHERE id=1").toArray()[0]?.version ?? 0;
      if (version > 3) throw new Problem("UNKNOWN_STATE_SCHEMA", 503);
      storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_meta (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      for (const name of collections) {
        storage.sql.exec("CREATE TABLE IF NOT EXISTS " + table(name) + " (id TEXT PRIMARY KEY, parent TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL)");
        storage.sql.exec("CREATE INDEX IF NOT EXISTS " + table(name) + "_parent ON " + table(name) + "(parent,id)");
      }
      for(const name of ["tasks","operations"] as const){
        const columns=storage.sql.exec<{name:string}>("PRAGMA table_info("+table(name)+")").toArray();
        if(!columns.some(c=>c.name==="header")){
          if(version>=3)throw new Problem("INVALID_ENTITY_HEADER",503);
          storage.sql.exec("ALTER TABLE "+table(name)+" ADD COLUMN header TEXT");
        }
      }
      storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_history_counts (conversation_id TEXT PRIMARY KEY, turns INTEGER NOT NULL CHECK(turns>=0))");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_messages_position ON pra_data_messages(parent,position,id)");
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
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_tasks_request ON pra_data_tasks(json_extract(header,'$.requestId'))");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_tasks_created ON pra_data_tasks(json_extract(header,'$.created') DESC,id DESC)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_tasks_conversation_created ON pra_data_tasks(parent,json_extract(header,'$.created') DESC,id DESC)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_tasks_status_created ON pra_data_tasks(json_extract(header,'$.status'),json_extract(header,'$.created') DESC,id DESC)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_tasks_active ON pra_data_tasks(id) WHERE json_extract(header,'$.status') NOT IN ('completed','failed','cancelled')");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_tasks_open ON pra_data_tasks(id) WHERE json_extract(header,'$.status') NOT IN ('completed','failed','cancelled') OR json_extract(header,'$.runOpen')=1");
    });
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
    for (const name of ["tasks", "operations", "memories", "notices", "plans"] as const) { add(name, state[name]); delete rest[name]; }
    add("papers", Object.entries(state.papers).map(([key, paper]) => ({ key, paper })), v => v.key, () => "");
    delete rest.papers;
    if (state.conversations) {
      add("conversations", state.conversations.map(c => Object.fromEntries(Object.keys(c).filter(k=>k!=="history").map(k=>[k,(c as any)[k]]))));
      const messages:any[]=[];
      for(const c of state.conversations){
        const partition=this.histories.get(c.id);
        if(partition?.conversation===c&&!partition.loaded){untouched.add(c.id);continue;}
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
      partition.loaded=true;
    }
    return partition.value;
  }
  historyCount(conversation:Conversation){
    const partition=this.histories.get(conversation.id);
    return partition?.conversation===conversation&&!partition.loaded?this.historyCounts.get(conversation.id)??0:conversation.history.length;
  }
  private attachHistory(conversation:Conversation){
    const partition:HistoryPartition={conversation,loaded:false,value:[],base:0};
    this.histories.set(conversation.id,partition);
    Object.defineProperty(conversation,"history",{enumerable:true,configurable:true,
      get:()=>this.loadHistory(partition),
      set:(value:Conversation["history"])=>{if(!Array.isArray(value))throw new Problem("INVALID_HISTORY");this.loadHistory(partition);partition.value=value;}
    });
    return conversation;
  }
  private attachEntity(name:LazyCollection,row:{id:string;parent:string;position:number}){
    const entity=lazyEntity(name,{id:row.id},row.position,()=>{
      const stored=this.storage.sql.exec<Row>("SELECT id,parent,position,value FROM "+table(name)+" WHERE id=?",row.id).toArray()[0];
      if(!stored)throw new Problem("ENTITY_UNAVAILABLE",503);
      // Cache the original persisted bytes before exposing a mutable payload.
      this.cached.set(name+":"+row.id,serial(stored));
      return parse<Record<string,any>>(stored.value);
    },()=>{
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
        const rows=this.storage.sql.exec<{id:string;parent:string;position:number}>("SELECT id,parent,position FROM "+table(name)+" ORDER BY position,id").toArray();
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
    if (state.cloudMemory) state.cloudMemory.entries = all("memory_entries");
    return state;
  }
  load(): State {
    this.entities=new WeakMap();this.histories.clear();this.cached.clear();this.messageParents.clear();this.positions.clear();
    this.historyCounts=new Map(this.storage.sql.exec<{conversation_id:string;turns:number}>("SELECT conversation_id,turns FROM pra_history_counts").toArray().map(r=>[r.conversation_id,r.turns]));
    const state = this.read(true);
    this.knownConversations=new Set((state.conversations??[]).map(c=>c.id));
    this.cached = this.fingerprints(this.split(state));
    bindTaskQueries(state,{page:query=>this.taskPageRows(state,query),active:includeOpen=>this.activeTaskRows(state,includeOpen),byRequest:requestId=>this.taskRequest(state,requestId)});
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
  private taskPageRows(state:State,query:TaskPageQuery):Task[]{
    const {saved,overlay}=this.taskOverlay(state),selected:Task[]=[];
    let timestamp=query.timestamp,id=query.id;
    while(saved.size&&selected.length<query.limit+1){
      const where:string[]=[],args:any[]=[];
      if(query.conversationId){where.push("parent=?");args.push(query.conversationId);}
      if(query.status){where.push("json_extract(header,'$.status')=?");args.push(query.status);}
      const select=(condition:string,bindings:any[],limit:number,sameTime=false)=>this.storage.sql.exec<{id:string;created:number}>("SELECT id,json_extract(header,'$.created') AS created FROM pra_data_tasks WHERE "+[condition,...where].join(" AND ")+" ORDER BY "+(sameTime?"id DESC":"json_extract(header,'$.created') DESC,id DESC")+" LIMIT ?",...bindings,...args,limit).toArray();
      // Separate equal-time and older ranges: a tuple/OR over JSON expressions can scan the entire prefix.
      const rows=select("json_extract(header,'$.created')=? AND id<?",[timestamp,id],query.limit+1,true);
      if(rows.length<query.limit+1)rows.push(...select("json_extract(header,'$.created')<?",[timestamp],query.limit+1-rows.length));
      if(!rows.length)break;
      for(const row of rows){const task=saved.get(row.id);if(task)selected.push(task);}
      const last=rows.at(-1)!;timestamp=last.created;id=last.id;
      if(rows.length<query.limit+1)break;
    }
    return [...selected,...overlay.filter(t=>matchesTaskPage(t,query))].sort(taskPageOrder).slice(0,query.limit+1);
  }
  private activeTaskRows(state:State,includeOpen:boolean):Task[]{
    const {saved,overlay}=this.taskOverlay(state),selected:Task[]=[],predicate="json_extract(header,'$.status') NOT IN ('completed','failed','cancelled')"+(includeOpen?" OR json_extract(header,'$.runOpen')=1":"");
    let after="";
    while(saved.size){
      const rows=this.storage.sql.exec<{id:string}>("SELECT id FROM pra_data_tasks WHERE ("+predicate+") AND id>? ORDER BY id LIMIT 200",after).toArray();
      for(const row of rows){const task=saved.get(row.id);if(task)selected.push(task);}
      if(rows.length<200)break;after=rows.at(-1)!.id;
    }
    const ids=new Set([...selected,...overlay.filter(t=>!closedTask(t)||(includeOpen&&t.runOpen))].map(t=>t.id));
    return state.tasks.filter(t=>ids.has(t.id));
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
    for(const [id,count] of split.counts)this.historyCounts.set(id,count);
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
