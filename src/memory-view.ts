import type {Memory} from "./domain.ts";
import type {CloudMemoryEntry} from "../packages/research/cloud-memory.ts";
/** Compatibility reads always resolve to the canonical entry, never to a second mutable memory. */
export function memoryView(entries:readonly CloudMemoryEntry[]):Memory[]{
 return entries.map(entry=>({id:entry.id,get content(){return entry.content;},get source(){return entry.source_session||"user";},get updated(){return Date.parse(entry.updated_at);}}));
}
