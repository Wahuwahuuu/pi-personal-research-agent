"""Restricted desktop control. Credentials never cross the JavaScript bridge."""
from __future__ import annotations
import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser

ROOT = Path(__file__).resolve().parents[2]
HIDDEN = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
ENV_KEYS = {"PATH","SYSTEMROOT","WINDIR","COMSPEC","PATHEXT","TEMP","TMP","USERPROFILE","APPDATA","LOCALAPPDATA","PROGRAMFILES","PROGRAMFILES(X86)","PROGRAMDATA","HOMEDRIVE","HOMEPATH","PROCESSOR_ARCHITECTURE","NUMBER_OF_PROCESSORS"}

class LocalError(Exception):
    pass

def safe_environment():
    return {k:v for k,v in os.environ.items() if k.upper() in ENV_KEYS}

def safe_endpoint(value):
    u = urllib.parse.urlsplit(value)
    if u.username or u.password or u.query or u.fragment or (u.scheme != "https" and not (u.scheme == "http" and u.hostname in ("127.0.0.1","localhost"))):
        raise LocalError("INVALID_ENDPOINT")
    if not u.hostname: raise LocalError("INVALID_ENDPOINT")
    return value.rstrip("/")

class Controller:
    def __init__(self, config_path:Path):
        self.path = config_path.resolve(strict=True)
        self.config = json.loads(self.path.read_text(encoding="utf8"))
        self.endpoint = safe_endpoint(self.config["endpoint"])
        self.port = self.config.get("port",48731)
        if type(self.port) is not int or not 1024 <= self.port <= 65535: raise LocalError("INVALID_LOCAL_PORT")
        self.data = self.resolve(self.config["dataDir"])
        self.secret = self.resolve(self.config.get("localSecretFile", str(self.data/"local.secret")))
        key = str(self.path).lower() if os.name == "nt" else str(self.path)
        self.control_directory = self.data/".control"/hashlib.sha256(key.encode()).hexdigest()
        self._tray_instance = None
        self._token = None
        self._node = None
        self._lock = threading.Lock()
        self._http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def begin_tray(self):
        # Only called after acquiring the per-config mutex.
        self.control_directory.mkdir(parents=True,exist_ok=True)
        (self.control_directory/"stop").unlink(missing_ok=True)
        self._tray_instance = str(uuid.uuid4())
        temporary=self.control_directory/("tray-"+self._tray_instance+".tmp")
        temporary.write_text(json.dumps({"pid":os.getpid(),"instance":self._tray_instance}),encoding="utf8")
        temporary.replace(self.control_directory/"tray.json")
    def end_tray(self):
        path=self.control_directory/"tray.json"
        try:
            value=json.loads(path.read_text(encoding="utf8"))
            if value.get("instance")==self._tray_instance:path.unlink(missing_ok=True)
        except (OSError,ValueError):pass
    def stop_requested(self):
        return (self.control_directory/"stop").exists()
    def resolve(self, value):
        p = Path(value)
        return (p if p.is_absolute() else ROOT/p).resolve()
    def credential(self):
        if self._token: return self._token
        if os.name != "nt" or not self.secret.is_file(): raise LocalError("LOCAL_CREDENTIAL_UNAVAILABLE")
        result = subprocess.run(["powershell.exe","-NoProfile","-NonInteractive","-File",str(ROOT/"scripts/read-secret.ps1"),str(self.secret)],
                                capture_output=True,creationflags=HIDDEN,timeout=15,env=safe_environment())
        if result.returncode: raise LocalError("LOCAL_CREDENTIAL_UNAVAILABLE")
        value = result.stdout.decode("utf8").strip()
        if not 32 <= len(value) <= 256: raise LocalError("INVALID_LOCAL_CREDENTIAL")
        self._token = value
        return value
    def request(self, path, body=None, *, binary=False):
        headers = {"Authorization":"Bearer "+self.credential()}
        data = None
        if body is not None:
            data = json.dumps(body,ensure_ascii=False).encode("utf8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request("http://127.0.0.1:"+str(self.port)+"/local/"+path,data=data,headers=headers)
        try:
            with self._http.open(request,timeout=60 if binary else 15) as response:
                result = response.read((64*1024*1024 if binary else 1024*1024)+1)
                if len(result) > (64*1024*1024 if binary else 1024*1024): raise LocalError("LOCAL_RESPONSE_LIMIT")
                if binary:
                    if not result.startswith(b"%PDF-"): raise LocalError("INVALID_PDF_RESPONSE")
                    return result
                return json.loads(result)
        except urllib.error.HTTPError as error:
            if error.code == 401: self._token = None
            try: code = json.loads(error.read(10000)).get("error","LOCAL_REQUEST_FAILED")
            except (ValueError,AttributeError): code = "LOCAL_REQUEST_FAILED"
            raise LocalError(code if isinstance(code,str) and re.fullmatch("[A-Z_]{1,80}",code) else "LOCAL_REQUEST_FAILED") from None
        except (OSError,ValueError) as error:
            raise LocalError("LOCAL_SERVICE_UNAVAILABLE") from None
    def status(self):
        try: return {"ok":True,**self.request("status")}
        except LocalError as error: return {"ok":False,"connected":False,"ready":False,"phase":"stopped","error":str(error)}
    def start(self):
        with self._lock:
            if self.stop_requested(): raise LocalError("LOCAL_STOP_REQUESTED")
            if self.status()["ok"]: return {"accepted":True,"existing":True}
            if self._node and self._node.poll() is None: return {"accepted":True,"starting":True}
            # A fixed executable and entry point; selected papers can never become process arguments.
            node = shutil.which("node.exe" if os.name == "nt" else "node")
            if not node: raise LocalError("NODE_NOT_INSTALLED")
            self._node = subprocess.Popen([node,str(ROOT/"local/node.ts"),str(self.path)],cwd=ROOT,env=safe_environment(),
                                          creationflags=HIDDEN,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            return {"accepted":True,"starting":True}
    def control(self, action):
        if action not in ("pause","resume","reconnect","shutdown"): raise LocalError("ACTION_DENIED")
        return self.request("control",{"action":action})
    def import_pdf(self, chosen):
        p = Path(chosen).resolve(strict=True)
        if not p.is_file() or p.suffix.lower() != ".pdf": raise LocalError("TEXT_PDF_REQUIRED")
        return self.request("import",{"requestId":str(uuid.uuid4()),"kind":"pdf","path":str(p),"metadata":{"title":p.stem[:200]}})
    def import_arxiv(self, arxiv_id):
        if not isinstance(arxiv_id,str) or not re.fullmatch(r"\d{4}\.\d{4,5}v[1-9]\d{0,3}",arxiv_id): raise LocalError("VERSIONED_ARXIV_ID_REQUIRED")
        return self.request("import",{"requestId":str(uuid.uuid4()),"kind":"arxiv","arxivId":arxiv_id})
    def job(self, action, identifier):
        if action not in ("cancel","retry") or not isinstance(identifier,str) or len(identifier)>256: raise LocalError("ACTION_DENIED")
        return self.request("import/"+action,{"id":identifier})
    def library(self, query="", offset=0):
        if not isinstance(query,str) or len(query)>200 or type(offset) is not int or not 0<=offset<=100000: raise LocalError("INVALID_LOCAL_REQUEST")
        return self.request("library?"+urllib.parse.urlencode({"q":query,"offset":offset}))
    def reader_file(self, paper, version):
        if not all(isinstance(v,str) and 0<len(v)<=256 for v in (paper,version)): raise LocalError("UNKNOWN_PAPER")
        data = self.request("pdf?"+urllib.parse.urlencode({"paperId":paper,"indexVersion":version}),binary=True)
        directory = self.data/".cache"/"reader"
        directory.mkdir(parents=True,exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=directory,suffix=".pdf",delete=False) as file:
            file.write(data)
            return Path(file.name)
    def reader_poll(self):
        item=self.request("reader/poll",{})
        if item is None:return None
        if not isinstance(item,dict) or not all(isinstance(item.get(k),str) and 0<len(item[k])<=256 for k in ("id","paperId","indexVersion")):
            raise LocalError("INVALID_READER_REQUEST")
        page=item.get("page",1)
        if type(page) is not int or not 1<=page<=1000:raise LocalError("INVALID_PDF_PAGE")
        return {"id":item["id"],"paperId":item["paperId"],"indexVersion":item["indexVersion"],"page":page}
    def reader_valid(self,identifier):
        return self.request("reader/check",{"id":identifier}).get("valid") is True
    def reader_result(self,identifier,opened):
        return self.request("reader/result",{"id":identifier,"opened":bool(opened)})
    def diagnostics(self):
        state=self.status()
        return {"protocol":1,"connected":bool(state.get("connected")),"ready":bool(state.get("ready")),
                "paused":bool(state.get("paused")),"phase":state.get("phase"),"error":state.get("error"),
                "indexVersion":state.get("indexVersion"),"libraryEnabled":bool(state.get("libraryEnabled")),
                "importStates":{status:sum(j.get("status")==status for j in state.get("imports",[])) for status in
                                ("queued","acquiring","parsing","indexing","validating","published","failed","cancelled")}}
    def open_web(self):
        webbrowser.open(self.endpoint,new=2)
        return {"opened":True}
