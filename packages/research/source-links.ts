/** Pure source identity helpers shared by the Worker, local readers and UI. Bare legacy IDs mean v1. */
export function arxivVersion(id:string):string|null {
  return /^\d{4}\.\d{4,5}(?:v[1-9]\d{0,3})?$/.test(id) ? /v[1-9]\d*$/.test(id) ? id : id+"v1" : null;
}
export const originalPdfUrl=(id:string)=>{const version=arxivVersion(id);return version?"https://arxiv.org/pdf/"+version:null;};
export function isScientificUrl(raw:string,id:string):boolean {
  const version=arxivVersion(id);if(!version)return false;
  try {const u=new URL(raw);return u.protocol==="https:"&&!u.username&&!u.password&&!u.port&&!u.search&&["arxiv.org","ar5iv.labs.arxiv.org"].includes(u.hostname)&&u.pathname==="/html/"+version;}
  catch{return false;}
}
