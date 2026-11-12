import { digest } from "./auth.ts";
import { Problem, text } from "./domain.ts";
import type { StateStorage } from "./state-store.ts";
type Pair = { request_id: string; body_hash: string; device_id: string };
type Device = { id: string; hash: string; label: string; created: number; expires: number; revoked: number };
export class DevicePairings {
  readonly db: StateStorage;
  constructor(db: StateStorage) {
    this.db = db;
    db.sql.exec("CREATE TABLE IF NOT EXISTS pra_device_pairs(request_id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,device_id TEXT NOT NULL UNIQUE)");
  }
  active(id: string, hash: string, now = Date.now()) {
    const d = this.db.sql.exec<Device>("SELECT * FROM pra_devices WHERE id=?", id).toArray()[0];
    const auth = this.db.sql.exec<{expires:number}>("SELECT expires FROM pra_auth WHERE hash=? AND kind='device'", hash).toArray()[0];
    if (!d || d.revoked || !auth) throw new Problem("PAIRING_REVOKED", 409);
    if (d.expires <= now || auth.expires <= now) throw new Problem("PAIRING_EXPIRED", 409);
    if (d.hash !== hash) throw new Problem("PAIRING_KEY_CHANGED", 409);
    return d;
  }
  async issue(owner: string, secret: string, body: {requestId?:unknown;label?:unknown}, now = Date.now()) {
    const requestId = body.requestId === undefined ? crypto.randomUUID() : text(body.requestId, 128);
    const label = text(body.label ?? "Windows", 80);
    if (!secret || secret.length < 32) throw new Problem("PAIRING_NOT_CONFIGURED", 503);
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(["pra-device-pair-v1", owner, requestId])));
    const token = "pra_d1_" + Array.from(new Uint8Array(signature), b=>b.toString(16).padStart(2,"0")).join("");
    const hash = await digest(token), bodyHash = await digest(JSON.stringify({label}));
    const device = this.db.transactionSync(()=>{
      const old = this.db.sql.exec<Pair>("SELECT * FROM pra_device_pairs WHERE request_id=?", requestId).toArray()[0];
      if (old) {
        if (old.body_hash !== bodyHash) throw new Problem("IDEMPOTENCY_CONFLICT", 409);
        const d = this.db.sql.exec<Device>("SELECT * FROM pra_devices WHERE id=?", old.device_id).toArray()[0];
        if (d && d.hash !== hash) throw new Problem("PAIRING_KEY_CHANGED", 409);
        return this.active(old.device_id, hash, now);
      }
      const d: Device = {id:crypto.randomUUID(), hash, label, created:now, expires:now+90*86400000, revoked:0};
      this.db.sql.exec("INSERT INTO pra_auth VALUES(?,'device',?)", hash, d.expires);
      this.db.sql.exec("INSERT INTO pra_devices(id,hash,label,created,expires) VALUES(?,?,?,?,?)", d.id,hash,label,now,d.expires);
      this.db.sql.exec("INSERT INTO pra_device_pairs VALUES(?,?,?)", requestId,bodyHash,d.id);
      return d;
    });
    return {token, hash, id:device.id, expires:device.expires, expiresInDays:Math.ceil((device.expires-now)/86400000)};
  }
}
