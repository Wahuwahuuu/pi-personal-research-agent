import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {resolve,join,relative} from "node:path";
import {tmpdir} from "node:os";
const script=resolve("scripts/install-startup.ps1");
const command=`
$ErrorActionPreference='Stop'
$v=[Console]::In.ReadToEnd()|ConvertFrom-Json
$global:fixture=$v
function Get-ScheduledTask {
 param($TaskName)
 if($global:fixture.kind -eq 'none'){return $null}
 $i=[Security.Principal.WindowsIdentity]::GetCurrent()
 $a='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+(Join-Path (Split-Path -Parent $global:fixture.script) 'start-desktop.ps1')+'" -Config "'+$global:fixture.config+'"'
 $h=[Security.Cryptography.SHA256]::Create()
 try{$hash=([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($global:fixture.config.ToLowerInvariant())))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
 $d='PRA_CONFIG_SHA256='+$hash
 if($global:fixture.kind -eq 'foreign-description'){$d='unrelated'}
 if($global:fixture.kind -eq 'foreign-action'){$a='-File "C:\\Unrelated\\task.ps1"'}
 $user=$i.Name;if($global:fixture.kind -eq 'foreign-user'){$user='unrelated-user'}
 return [pscustomobject]@{Description=$d;Principal=[pscustomobject]@{UserId=$user};Actions=@([pscustomobject]@{Execute='powershell.exe';Arguments=$a})}
}
function New-ScheduledTaskAction {param($Execute,$Argument);return [pscustomobject]@{Execute=$Execute;Arguments=$Argument}}
function New-ScheduledTaskTrigger {param([switch]$AtLogOn,$User);return @{}}
function New-ScheduledTaskPrincipal {param($UserId,$LogonType,$RunLevel);return @{}}
function New-ScheduledTaskSettingsSet {param([switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,[switch]$StartWhenAvailable,$RestartCount,$RestartInterval,$ExecutionTimeLimit);return @{}}
function Register-ScheduledTask {param($TaskName,$Description,$Action,$Trigger,$Principal,$Settings,[switch]$Force);[Console]::Out.WriteLine((@{mutation='register';name=$TaskName;description=$Description;arguments=$Action.Arguments}|ConvertTo-Json -Compress))}
function Unregister-ScheduledTask {param($TaskName,$Confirm);[Console]::Out.WriteLine((@{mutation='remove';name=$TaskName}|ConvertTo-Json -Compress))}
$p=@{Config=$v.config};if($v.remove){$p.Remove=$true};if($v.status){$p.Status=$true}
& $v.script @p
`;
function run(config:string,kind:string,extra={}){
 try{return {ok:true,output:execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{input:JSON.stringify({script,config,kind,...extra}),encoding:"utf8",windowsHide:true,stdio:["pipe","pipe","pipe"]})};}
 catch(e){return {ok:false,output:String((e as any).stdout??""),error:String((e as any).stderr??"")};}
}
test("startup registration is configuration-scoped and refuses foreign tasks before any mutation",{skip:process.platform!=="win32"},async()=>{
 const root=await mkdtemp(join(tmpdir(),"pra-startup-"));
 try{
  const a=join(root,"a.json"),b=join(root,"b.json");await writeFile(a,"{}");await writeFile(b,"{}");
  const first=run(a,"none"),second=run(b,"none");assert.equal(first.ok,true,first.error??"");assert.equal(second.ok,true,second.error??"");
  const row=(r:{output:string})=>JSON.parse(r.output.split("\n").find(l=>l.includes('"mutation"'))!);
  assert.notEqual(row(first).name,row(second).name);assert.ok(row(first).arguments.includes(a));assert.ok(row(first).description.startsWith("PRA_CONFIG_SHA256="));
  for(const kind of ["foreign-description","foreign-action","foreign-user"]){
   for(const remove of [false,true]){const r=run(a,kind,{remove});assert.equal(r.ok,false);assert.ok(!r.output.includes('"mutation"'));}
  }
  assert.equal(run(a,"owned",{remove:true}).ok,true);
  const status=run(a,"owned",{status:true});assert.equal(status.ok,true);assert.equal(JSON.parse(status.output).registered,true);assert.ok(!status.output.includes('"mutation"'));
  assert.equal(JSON.parse(run(a,"none",{status:true}).output).registered,false);
 }finally{assert.ok(relative(resolve(tmpdir()),root).startsWith("pra-startup-"));await rm(root,{recursive:true,force:true,maxRetries:5});}
});
