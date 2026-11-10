import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {containedPath,sha} from './config.ts';
import {RuntimeFailure,redactText,object,type WorkerTransport,type Paper} from './contracts.ts';
import type {ReadingNote,DomainState} from './domain-memory.ts';
import {isConversationalInput} from './question-preparation.ts';
import {readingTopic,readingMemoryContent,type MemoryDigest} from './memory-synthesis.ts';

export {LongTermMemory,memoryProjection} from "./memory-service.ts";
export type {LongMemoryEntry,MemoryRecall,MemoryPage,MemoryOwner} from "./memory-service.ts";
import type {MemoryOwner} from "./memory-service.ts";
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const clip=(text:string,n:number)=>Array.from(text).slice(0,n).join('');
const credential=/(?:api[_ -]?key|access[_ -]?token|密钥|密码|口令)\s*(?:[:：=]|是|为)\s*\S+|\bBearer\s+[A-Za-z0-9._-]+|\bsk-[A-Za-z0-9_-]{16,}|\b[a-f0-9]{32}\.[A-Za-z0-9_-]{12,}|\b[a-f0-9-]{36}\.[a-f0-9]{64}\b|-----BEGIN[^\n]*PRIVATE KEY/iu;

/** Browser credentials stay outside model contexts and are stored only as digests. */
export class MemoryOwners {
  constructor(privateRoot:string){this.root=privateRoot;}private root:string;
  private async path(id:string){if(!uuid.test(id))throw new RuntimeFailure('FORBIDDEN','Invalid memory owner');return containedPath(this.root,`.local/memory/owners/${id}.json`);}
  async create(){const id=randomUUID(),token=randomBytes(32).toString('hex'),path=await this.path(id);await mkdir(join(this.root,'.local/memory/owners'),{recursive:true});if((await readdir(join(this.root,'.local/memory/owners'))).length>=1000)throw new RuntimeFailure('CAPACITY','Memory profile limit');await writeFile(path,JSON.stringify({token_digest:sha(token),enabled:true,created_at:new Date().toISOString()})+'\n',{flag:'wx'});return {credential:id+'.'+token,enabled:true};}
  async authenticate(value:string):Promise<MemoryOwner>{
    const [id,token,...rest]=value.split('.');if(rest.length||!uuid.test(id??'')||!(/^[a-f0-9]{64}$/u.test(token??'')))throw new RuntimeFailure('FORBIDDEN','Memory owner differs');
    let data;try{data=JSON.parse(await readFile(await this.path(id),'utf8'));}catch{throw new RuntimeFailure('FORBIDDEN','Memory profile missing');}
    const actual=Buffer.from(sha(token)),expected=Buffer.from(String(data.token_digest));if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new RuntimeFailure('FORBIDDEN','Memory owner differs');return {id,enabled:data.enabled!==false};
  }
  async configure(credential:string,enabled:boolean){const owner=await this.authenticate(credential),path=await this.path(owner.id),data=JSON.parse(await readFile(path,'utf8')),temp=path+'.'+randomUUID()+'.partial';await writeFile(temp,JSON.stringify({...data,enabled})+'\n',{flag:'wx'});await rename(temp,path);return {...owner,enabled};}
}
