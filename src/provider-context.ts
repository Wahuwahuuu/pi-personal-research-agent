/** A managed host submission contains a complete, bounded projection of research context.
 * Keep that submission and subsequent current-step tool messages, while retaining the full
 * Pi transcript in storage. Unmanaged callers keep their existing context behavior. */
export function projectProviderMessages<T extends {role:string;content?:unknown}>(messages:readonly T[]):T[]{
 const last=messages.findLastIndex(m=>m.role==="user");if(last<0)return [...messages];
 const content=messages[last].content,raw=typeof content==="string"?content:Array.isArray(content)?content.filter(c=>c?.type==="text").map(c=>c.text).join("\n"):"";
 try{if(JSON.parse(raw)?.projection==="pra-context-v1")return messages.slice(last);}catch{}
 return [...messages];
}
