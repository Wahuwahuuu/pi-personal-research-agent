"""First-run window; only fixed local actions, no cloud model credentials."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import subprocess
import threading
from controller import ROOT, HIDDEN, safe_environment

class SetupController:
    def __init__(self, node, config, release=None):
        self.node=str(Path(node).resolve(strict=True))
        self.config=str(Path(config).resolve())
        self.release=str(Path(release).resolve(strict=True)) if release else None
        self.lock=threading.Lock()
        self.phase=""
    def progress(self): return {"busy":self.lock.locked(),"phase":self.phase}
    def request(self, action, value=None, credential=None):
        if action not in {"status","check","install","activate","start"}:return {"ok":False,"error":"INVALID_SETUP_ACTION"}
        if not self.lock.acquire(blocking=False):return {"ok":False,"error":"SETUP_BUSY"}
        try:
            self.phase={"check":"checking","install":"checking","activate":"preparing","start":"starting"}.get(action,"")
            args=[self.node,str(ROOT/"scripts/first-run.ts"),"--config",self.config]
            if self.release:args+=["--release",self.release]
            payload={"action":action}
            if value is not None:payload["input"]=value
            if credential is not None:payload["credential"]=credential
            child=subprocess.Popen(args,cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,creationflags=HIDDEN,env=safe_environment())
            timer=threading.Timer(900,child.kill);timer.daemon=True;timer.start()
            try:
                child.stdin.write(json.dumps(payload,ensure_ascii=False).encode("utf8"));child.stdin.close()
                payload.clear();credential=None
                result=None;size=0
                for line in child.stdout:
                    size+=len(line)
                    if size>65536:child.kill();raise ValueError()
                    reply=json.loads(line.decode("utf8"))
                    if "phase" in reply and reply["phase"] in {"checking","pairing","saving","preparing"}:self.phase=reply["phase"]
                    elif "ok" in reply:result=reply
                child.wait(timeout=5)
                if result is None:return {"ok":False,"error":"SETUP_ACTION_FAILED"}
                return result
            finally:
                timer.cancel()
                if child.poll() is None:child.kill();child.wait(timeout=5)
        except Exception:return {"ok":False,"error":"SETUP_ACTION_FAILED"}
        finally:self.phase="";self.lock.release()
    def startup(self, remove=False, status=False):
        if not self.lock.acquire(blocking=False):return {"ok":False,"error":"SETUP_BUSY"}
        try:
            args=["powershell.exe","-NoProfile","-NonInteractive","-File",str(ROOT/"scripts/install-startup.ps1"),"-Config",self.config]
            if remove:args.append("-Remove")
            if status:args.append("-Status")
            result=subprocess.run(args,cwd=ROOT,capture_output=True,creationflags=HIDDEN,env=safe_environment(),timeout=30)
            if result.returncode:return {"ok":False,"error":"STARTUP_REGISTRATION_FAILED"}
            return {"ok":True,"value":json.loads(result.stdout.decode("utf-8-sig")) if status else {"registered":not remove}}
        except Exception:return {"ok":False,"error":"STARTUP_REGISTRATION_FAILED"}
        finally:self.lock.release()

def main():
    if os.name!="nt":raise SystemExit("WINDOWS_REQUIRED")
    import webview
    import ctypes
    parser=argparse.ArgumentParser()
    parser.add_argument("--node",required=True)
    parser.add_argument("--config",required=True)
    parser.add_argument("--release")
    args=parser.parse_args()
    controller=SetupController(args.node,args.config,args.release)
    kernel=ctypes.WinDLL("kernel32",use_last_error=True)
    kernel.CreateMutexW.argtypes=[ctypes.c_void_p,ctypes.c_bool,ctypes.c_wchar_p]
    kernel.CreateMutexW.restype=ctypes.c_void_p
    mutex=kernel.CreateMutexW(None,False,"Local\\PRA.Setup."+hashlib.sha256(controller.config.casefold().encode()).hexdigest())
    if not mutex or ctypes.get_last_error()==183:return
    view=None
    class Api:
        def status(self):
            result=controller.request("status")
            if result.get("ok") and result["value"].get("ready"):
                result["value"]["startup"]=controller.startup(status=True).get("value",{}).get("registered")
            return result
        def progress(self):return controller.progress()
        def choose_directory(self):
            if controller.lock.locked():return {"ok":False,"error":"SETUP_BUSY"}
            result=view.create_file_dialog(webview.FileDialog.FOLDER)
            return {"ok":True,"value":str(Path(result[0]).resolve()) if result else None}
        def check(self,value):return controller.request("check",value)
        def install(self,value,credential):return controller.request("install",value,credential)
        def activate(self):
            result=controller.request("activate")
            if result.get("ok"):result["value"]["startup"]=controller.startup(status=True).get("value",{}).get("registered")
            return result
        def start(self):return controller.request("start")
        def startup(self,remove=False):return controller.startup(remove is True)
    view=webview.create_window("连接本机 · Aster",str(ROOT/"local/desktop/setup.html"),js_api=Api(),width=800,height=820,min_size=(580,540))
    # Do not abandon an in-progress pairing/write when the close button is pressed.
    view.events.closing+=lambda:not controller.lock.locked()
    webview.start(debug=False)
if __name__=="__main__":main()
