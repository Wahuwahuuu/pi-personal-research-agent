import test from "node:test";
import assert from "node:assert/strict";
import {changeFingerprint} from "../web/change-notification.ts";

test("identical notifications are reusable while device-only and persisted changes invalidate", () => {
  const event={type:"change",cursor:1,active:[],readerChanged:false,
    deviceState:{connected:true,ready:true,canImport:true,phase:"ready"}};
  const fingerprint=changeFingerprint(event);
  assert.ok(fingerprint);
  assert.equal(changeFingerprint(JSON.parse(JSON.stringify(event))),fingerprint);
  for(const patch of [
    {cursor:2}, {active:[{id:"t",status:"running"}]}, {readerChanged:true},
    {deviceState:{...event.deviceState,connected:false,ready:false,phase:"offline"}},
    {additionalState:1},
  ]) assert.notEqual(changeFingerprint({...event,...patch}),fingerprint);
});
test("old, malformed, and incomplete notifications force authoritative refresh", () => {
  for(const event of [null,{}, {type:"change",cursor:1,active:[],readerChanged:false},
    {type:"change",cursor:1,active:[],readerChanged:false,deviceState:{phase:"offline"}}])
    assert.equal(changeFingerprint(event),undefined);
});
