import {realpath} from "node:fs/promises";
import {createHash} from "node:crypto";
import {isAbsolute,relative,resolve,dirname} from "node:path";
import {RuntimeFailure} from "./contracts.ts";
export const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
export function projectPath(root: string, path: string): string {
  const target=resolve(root,path), rel=relative(resolve(root),target);
  if (!path || isAbsolute(path) || rel===".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel)) throw new RuntimeFailure("INVALID_PATH","Path must remain inside the project");
  return target;
}
/** Existing links must stay in the project; missing paths validate their nearest existing parent. */
export async function containedPath(root: string, path: string): Promise<string> {
  const target=projectPath(root,path), realRoot=await realpath(root);
  let probe=target;
  while (true) {
    try {
      const actual=await realpath(probe), rel=relative(realRoot,actual);
      if (rel===".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel)) throw new RuntimeFailure("INVALID_PATH","Linked path escapes the project");
      return target;
    } catch(e) {
      if ((e as NodeJS.ErrnoException).code!=="ENOENT") throw e;
      const parent=dirname(probe); if(parent===probe) throw e; probe=parent;
    }
  }
}
