import type { DatabaseSync } from "node:sqlite";
/** A directory must not replay one account's pending result to a different account. */
export function bindNodeAccount(db:DatabaseSync,scope:unknown){
 db.exec("CREATE TABLE IF NOT EXISTS node_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),scope TEXT NOT NULL)");
 const row=db.prepare("SELECT scope FROM node_identity WHERE singleton=1").get() as {scope:string}|undefined;
 // Older single-owner deployments omit scope. Once bound, never downgrade.
 if(scope===undefined&&!row)return;
 if(typeof scope!=="string"||!/[a-f0-9]{64}/.test(scope)||scope.length!==64)throw Error("ACCOUNT_SCOPE_REQUIRED");
 if(row&&row.scope!==scope)throw Error("ACCOUNT_DATA_DIRECTORY_MISMATCH");
 if(!row)db.prepare("INSERT INTO node_identity VALUES(1,?)").run(scope);
}
