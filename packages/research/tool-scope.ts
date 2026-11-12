import {RuntimeFailure} from "./internal/agent/contracts.ts";
import type {ToolContext} from "./internal/agent/tools.ts";

/** A host-owned retrieval boundary; an empty scope means the registered catalog. */
export function withPaperScope(context:ToolContext,value:unknown):ToolContext {
  if(value===undefined)return context;
  if(!Array.isArray(value)||value.length>5000||value.some(id=>typeof id!=="string"||!context.knownPaperIds.has(id))||new Set(value).size!==value.length)
    throw new RuntimeFailure("INVALID_SCOPE","Paper scope must contain distinct known catalog IDs");
  const scope=[...value] as string[];
  return {...context,getScope:()=>scope};
}
