"""Read-only installation checks. Reuse pinned model inventory; never download or load model weights."""
import importlib.metadata
import json
from pathlib import Path
import sys
import hashlib

def check(config):
    errors=[]
    if sys.version_info[:2] != (3,12):errors.append("PYTHON_312_REQUIRED")
    expected={"torch":"2.9.1","transformers":"4.57.3","numpy":"2.3.5","faiss-cpu":"1.15.1","rank-bm25":"0.2.2",
              "pypdf":"7.0.1","fonttools":"4.68.0","pystray":"0.19.5","pywebview":"6.2.1","pillow":"13.0.0"}
    versions={}
    for name,wanted in expected.items():
        try:versions[name]=importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:errors.append("DEPENDENCY_MISSING:"+name);continue
        if versions[name].split("+",1)[0] != wanted:errors.append("DEPENDENCY_VERSION:"+name)
    cuda=False
    if not errors:
        try:
            import torch
            cuda=torch.cuda.is_available()
            if config.get("device")=="cuda" and not cuda:errors.append("CUDA_UNAVAILABLE")
        except Exception:errors.append("TORCH_UNAVAILABLE")
    inventory=None
    if not errors:
        try:
            from retriever.p2 import model_inventory
            inventory=model_inventory(Path(config["models"]))
        except Exception:errors.append("MODEL_FILES_INVALID")
    return {"ok":not errors,"errors":errors,"python":".".join(map(str,sys.version_info[:3])),"versions":versions,"cudaAvailable":cuda,
            "models":inventory,"inventorySha256":hashlib.sha256(json.dumps(inventory,sort_keys=True).encode()).hexdigest() if inventory else None}
if __name__=="__main__":
    try:result=check(json.load(sys.stdin))
    except Exception:result={"ok":False,"errors":["RUNTIME_CHECK_FAILED"]}
    print(json.dumps(result))
    sys.exit(0 if result["ok"] else 1)
