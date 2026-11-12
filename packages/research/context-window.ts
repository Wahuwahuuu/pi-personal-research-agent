import type { DialogueRecord } from "./internal/agent/domain-memory.ts";
export interface ProjectedTurn {
  turn_id: string; user_text: string; final_answer?: string; truncated?: Array<"user_text" | "final_answer">;
}
export interface ContextWindow {
  version: 1; stage: string; stored_turns: number; visible_recent_turns: string[];
  omitted_valid_turns: number; invalidated_turns_excluded: number; truncated_recent_turns: string[];
  history_bytes: number; constraints: number; unresolved_questions: number; reading_notes: number; memories: number;
  answers_included: boolean;
}
const encoder=new TextEncoder();
const size=(s:unknown)=>encoder.encode(JSON.stringify(s)).length;
/** Count UTF-8 bytes at scalar boundaries; never cut an emoji or produce an unmatched surrogate. */
function clip(value:string,maximum:number){
  let bytes=0,result="";
  for(const char of value){const n=size(char)-2;if(bytes+n>maximum)break;bytes+=n;result+=char;}
  return result;
}
/** Select recent turns first, but return chronological order. Storage is never altered. */
export function projectRecentDialogue(records:readonly DialogueRecord[],includeAnswers:boolean){
  const items:ProjectedTurn[]=[];
  for(const record of [...records.slice(-4)].reverse()){
    const item:ProjectedTurn={turn_id:record.turn_id,user_text:clip(record.user_text,1200)};
    const truncated:NonNullable<ProjectedTurn["truncated"]>=[];
    if(item.user_text!==record.user_text)truncated.push("user_text");
    if(includeAnswers){
      item.final_answer=clip(record.final_answer,800);
      if(item.final_answer!==record.final_answer)truncated.push("final_answer");
    }
    if(truncated.length)item.truncated=truncated;
    if(size([item,...items])<=2500)items.unshift(item);
  }
  return {items,bytes:size(items),truncated:items.filter(i=>i.truncated?.length).map(i=>i.turn_id)};
}
