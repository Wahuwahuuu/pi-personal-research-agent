import type { StateStorage } from "./state-store.ts";

/** Shared across accounts. arXiv recommends a 3s gap between consecutive API requests.
 * https://info.arxiv.org/help/api/user-manual.html#3112-start-and-max_results-paging */
export class DiscoveryGate {
  private db: StateStorage;
  constructor(db: StateStorage) {
    this.db = db;
    db.sql.exec("CREATE TABLE IF NOT EXISTS pra_discovery_gate(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,token TEXT NOT NULL,expires INTEGER NOT NULL,next INTEGER NOT NULL)");
  }
  claim(owner: string, now = Date.now()) {
    return this.db.transactionSync(() => {
      const row = this.db.sql.exec<{owner:string;token:string;expires:number;next:number}>("SELECT * FROM pra_discovery_gate WHERE id=1").toArray()[0];
      const retryAt = Math.max(row?.expires ?? 0, row?.next ?? 0);
      if (retryAt > now) return {ok:false as const,retryAt};
      const token = crypto.randomUUID(), expires = now + 30000;
      this.db.sql.exec("INSERT INTO pra_discovery_gate VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,token=excluded.token,expires=excluded.expires,next=excluded.next",owner,token,expires,now+3000);
      return {ok:true as const,token,retryAt:expires};
    });
  }
  release(owner:string,token:string,now=Date.now()) {
    this.db.sql.exec("UPDATE pra_discovery_gate SET owner='',token='',expires=0,next=MAX(next,?) WHERE id=1 AND owner=? AND token=?",now+3000,owner,token);
  }
}
