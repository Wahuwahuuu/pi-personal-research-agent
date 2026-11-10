import {createResearchModule,type ResearchOptions} from "../index.ts";
/** Host integration: no Pi, storage internals or concrete Harness imports. */
export async function researchQuestion(options:ResearchOptions, question:string, conversationId?:string){
 const module=await createResearchModule(options);
 try{const session=await module.openSession(conversationId);return {conversationId:session.id,state:await session.ask(question)};}
 finally{await module.close();}
}
