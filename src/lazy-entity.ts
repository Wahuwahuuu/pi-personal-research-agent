import {createHash} from "node:crypto";
/** Fields needed for routing and recovery, without research text or tool payloads. */
export const entityHeaderKeys = {
 tasks: new Set(["id","requestId","kind","origin","status","created","updated","calls","tools","activeMs","engine","conversationId","budgetTaskId","translationKey","researchIndex","researchWaiting","runOpen","modelStoppedAt","resumeSeq","modelFailure","error","operationId","sessionId","modelOperation","modelStarted","modelAdmitted","priority","pauseRequested","pausedFrom","platformWait"]),
 memory_entries: new Set(["id","kind","paper_ids","source_session","source_turn","created_at","updated_at","slot","edited","projectId","category","sourceStatus","semanticStatus","active","score"]),
 operations: new Set(["id","taskId","tool","indexVersion","state","deadline","deliveryVersion","delivered","attempts"]),
};
export type LazyCollection=keyof typeof entityHeaderKeys;
export const isLazyCollection=(name:string):name is LazyCollection=>name==="tasks"||name==="operations"||name==="memory_entries";
export function entityHeader(name:LazyCollection,value:Record<string,unknown>){
 const header=Object.fromEntries([...entityHeaderKeys[name]].filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
 if(name==="memory_entries")header._payloadHash=createHash("sha256").update(JSON.stringify(value)).digest("hex");
 return header;
}
export interface LazyEntity {
 proxy:Record<string,any>;
 loaded:boolean;
 position:number;
 parent?:string;
 value?:Record<string,any>;
 load:()=>Record<string,any>;
 persistedHash?:()=>string|undefined;
}
const lazyValues=new WeakMap<object,LazyEntity>();
export function persistedEntityHash(value:object):string|undefined{const entity=lazyValues.get(value);return entity&&!entity.loaded?entity.persistedHash?.():undefined;}
/** One persisted entity is loaded on payload access; metadata lookups never hydrate other entities. */
export function lazyEntity(name:LazyCollection,header:Record<string,any>,position:number,read:()=>Record<string,any>,readHeader?:()=>Record<string,any>):LazyEntity{
 let headerLoaded=!readHeader;
 const getHeader=()=>{if(!headerLoaded){header=readHeader!();headerLoaded=true;}return header;};
 const onLoad:Array<(value:Record<string,any>)=>void>=[];
 const entity:LazyEntity={proxy:{},loaded:false,position,load(){
   if(!entity.loaded){entity.value=read();entity.loaded=true;for(const bind of onLoad)bind(entity.value);}
   return entity.value!;
 }};
 entity.persistedHash=()=>{const hash=getHeader()._payloadHash;return typeof hash==="string"&&/^[a-f0-9]{64}$/.test(hash)?hash:undefined;};
 const arrays=new Map<string,any[]>();
 const headerValue=(key:string)=>{
  const value=getHeader()[key];if(!Array.isArray(value))return value;
  if(!arrays.has(key)){
   let loadedArray:any[]|undefined;onLoad.push(body=>{loadedArray=body[key];});
   const current=()=>entity.loaded?loadedArray!:getHeader()[key];
   const writable=()=>{entity.load();return current();};
   arrays.set(key,new Proxy([],{
    get(_target,field,receiver){return Reflect.get(current(),field,receiver);},
    set(_target,field,item){return Reflect.set(writable(),field,item);},
    deleteProperty(_target,field){return Reflect.deleteProperty(writable(),field);},
    defineProperty(_target,field,descriptor){return Reflect.defineProperty(writable(),field,descriptor);},
    has(_target,field){return field in current();},
    ownKeys(){return Reflect.ownKeys(current());},
    getOwnPropertyDescriptor(_target,field){return Reflect.getOwnPropertyDescriptor(current(),field);},
   }));
  }
  return arrays.get(key);
 };
 entity.proxy=new Proxy({},{
   get(_target,key){return !entity.loaded&&typeof key==="string"&&entityHeaderKeys[name].has(key)?(key==="id"?header.id:headerValue(key)):Reflect.get(entity.load(),key);},
   set(_target,key,value){return Reflect.set(entity.load(),key,value);},
   deleteProperty(_target,key){return Reflect.deleteProperty(entity.load(),key);},
   has(_target,key){return !entity.loaded&&typeof key==="string"&&entityHeaderKeys[name].has(key)?(key==="id"?true:key in getHeader()):key in entity.load();},
   ownKeys(){return Reflect.ownKeys(entity.load());},
   getOwnPropertyDescriptor(_target,key){return Reflect.getOwnPropertyDescriptor(entity.load(),key);},
   defineProperty(_target,key,descriptor){return Reflect.defineProperty(entity.load(),key,descriptor);},
 });
 lazyValues.set(entity.proxy,entity);return entity;
}
