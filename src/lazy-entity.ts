/** Fields needed for routing and recovery, without research text or tool payloads. */
export const entityHeaderKeys = {
 tasks: new Set(["id","requestId","kind","origin","status","created","updated","calls","tools","activeMs","engine","conversationId","budgetTaskId","translationKey","researchIndex","researchWaiting","runOpen","modelStoppedAt","resumeSeq","modelFailure","error","operationId","sessionId","modelOperation","modelStarted","modelAdmitted","priority","pauseRequested","pausedFrom","platformWait"]),
 operations: new Set(["id","taskId","tool","indexVersion","state","deadline","deliveryVersion","delivered","attempts"]),
};
export type LazyCollection=keyof typeof entityHeaderKeys;
export const isLazyCollection=(name:string):name is LazyCollection=>name==="tasks"||name==="operations";
export function entityHeader(name:LazyCollection,value:Record<string,unknown>){
 return Object.fromEntries([...entityHeaderKeys[name]].filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
}
export interface LazyEntity {
 proxy:Record<string,any>;
 loaded:boolean;
 position:number;
 value?:Record<string,any>;
 load:()=>Record<string,any>;
}
/** One persisted entity is loaded on payload access; metadata lookups never hydrate other entities. */
export function lazyEntity(name:LazyCollection,header:Record<string,any>,position:number,read:()=>Record<string,any>):LazyEntity{
 const entity:LazyEntity={proxy:{},loaded:false,position,load(){
   if(!entity.loaded){entity.value=read();entity.loaded=true;}
   return entity.value!;
 }};
 entity.proxy=new Proxy({},{
   get(_target,key){return !entity.loaded&&typeof key==="string"&&entityHeaderKeys[name].has(key)?header[key]:Reflect.get(entity.load(),key);},
   set(_target,key,value){return Reflect.set(entity.load(),key,value);},
   deleteProperty(_target,key){return Reflect.deleteProperty(entity.load(),key);},
   has(_target,key){return !entity.loaded&&typeof key==="string"&&entityHeaderKeys[name].has(key)?key in header:key in entity.load();},
   ownKeys(){return Reflect.ownKeys(entity.load());},
   getOwnPropertyDescriptor(_target,key){return Reflect.getOwnPropertyDescriptor(entity.load(),key);},
   defineProperty(_target,key,descriptor){return Reflect.defineProperty(entity.load(),key,descriptor);},
 });
 return entity;
}
