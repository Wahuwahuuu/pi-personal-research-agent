import assert from "node:assert/strict";
export async function verifyPlanRecords(api:(path:string,method?:string,body?:any,expected?:number)=>Promise<any>){
 const id=crypto.randomUUID(),project=await api("projects","POST",{requestId:id+":project",title:"Discovery record test"});
 const input={requestId:id+":plan",projectId:project.id,query:"source grounded agents",objective:"Find reproducible evidence",enabled:false,autoProcess:false,maxPapers:2};
 const plan=await api("plans","POST",input);
 assert.equal(plan.projectId,project.id);assert.equal(plan.enabled,false);assert.equal(plan.autoProcess,false);
 assert.equal((await api("plans","POST",input)).id,plan.id);
 await api("plans","POST",{...input,query:"conflicting query"},409);
 const revised=await api("plans/"+plan.id,"PATCH",{requestId:id+":edit",query:"retrieval evaluation",objective:"Check retrieval evaluation",enabled:false});
 assert.equal(revised.revision,2);assert.equal(revised.query,"retrieval evaluation");
 await api("plans/"+plan.id,"PATCH",{requestId:id+":invalid",enabled:true,maxPapers:100},400);
 assert.equal((await api("overview")).plans.find((p:any)=>p.id===plan.id).enabled,false,"invalid updates must roll back in-memory state");
 assert.equal((await api("research-batches?plan="+plan.id)).items.length,0);
 await api("research-batches?limit=201","GET",undefined,400);
 await api("projects/"+project.id,"DELETE",{requestId:id+":delete"});
 assert.equal((await api("overview")).plans.some((p:any)=>p.id===plan.id),false);
 await api("plans","POST",input,404);
 return["plan writes are idempotent, permission-explicit, revisioned and removed with their project; invalid patches roll back"];
}
