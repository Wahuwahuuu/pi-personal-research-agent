"""Windows tray and minimal native windows. The cloud remains the only main Agent."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import threading
from controller import Controller, LocalError, ROOT

def main():
    if os.name != "nt": raise SystemExit("WINDOWS_REQUIRED")
    import webview
    import pystray
    from PIL import Image, ImageDraw
    parser=argparse.ArgumentParser()
    parser.add_argument("--config",type=Path,default=ROOT/".local/node.json")
    parser.add_argument("--show",action="store_true")
    args=parser.parse_args()
    controller=Controller(args.config)
    # A per-config Windows mutex prevents duplicate tray and launcher processes.
    import ctypes
    kernel=ctypes.WinDLL("kernel32",use_last_error=True)
    kernel.CreateMutexW.argtypes=[ctypes.c_void_p,ctypes.c_bool,ctypes.c_wchar_p]
    kernel.CreateMutexW.restype=ctypes.c_void_p
    mutex=kernel.CreateMutexW(None,False,"Local\\PRA.Tray."+hashlib.sha256(str(controller.path).casefold().encode()).hexdigest())
    if not mutex: raise LocalError("TRAY_LOCK_FAILED")
    if ctypes.get_last_error()==183:
        if args.show:
            controller.data.mkdir(parents=True,exist_ok=True)
            (controller.data/"tray-open").touch()
        return
    done=threading.Event()
    view=None
    icon=None
    reader_files=set()

    def result(call):
        try:return {"ok":True,"value":call()}
        except LocalError as error:return {"ok":False,"error":str(error)}
        except Exception:return {"ok":False,"error":"LOCAL_ACTION_FAILED"}
    class Api:
        def status(self): return controller.status()
        def start(self): return result(controller.start)
        def control(self,action): return result(lambda:controller.control(action))
        def import_pdf(self):
            def choose():
                selected=view.create_file_dialog(webview.FileDialog.OPEN,allow_multiple=True,file_types=("PDF 文件 (*.pdf)",))
                if not selected:return []
                if len(selected)>20:raise LocalError("IMPORT_SELECTION_LIMIT")
                return [controller.import_pdf(path) for path in selected]
            return result(choose)
        def import_arxiv(self,value):return result(lambda:controller.import_arxiv(value.strip() if isinstance(value,str) else value))
        def job(self,action,identifier):return result(lambda:controller.job(action,identifier))
        def library(self,query="",offset=0):return result(lambda:controller.library(query,offset))
        def open_web(self):return result(controller.open_web)
        def open_paper(self,paper,version,page=1):
            def open_reader():
                if type(page) is not int or not 1<=page<=1000:raise LocalError("INVALID_PDF_PAGE")
                path=controller.reader_file(paper,version);reader_files.add(path)
                reader=webview.create_window("论文全文 · Aster",url=path.as_uri()+"#page="+str(page),width=1050,height=800,min_size=(640,480),text_select=True)
                def clear():
                    try:path.unlink(missing_ok=True);reader_files.discard(path)
                    except OSError:pass
                reader.events.closed+=clear
                return {"opened":True}
            return result(open_reader)
        def diagnostics(self):
            def export():
                selected=view.create_file_dialog(webview.FileDialog.SAVE,save_filename="research-agent-diagnostics.json",file_types=("JSON 文件 (*.json)",))
                if not selected:return {"saved":False}
                path=Path(selected[0] if isinstance(selected,(list,tuple)) else selected)
                path.write_text(json.dumps(controller.diagnostics(),ensure_ascii=False,indent=2),encoding="utf8")
                return {"saved":True}
            return result(export)
    api=Api()
    view=webview.create_window("本机科研节点 · Aster",html=(ROOT/"local/desktop/panel.html").read_text(encoding="utf8"),js_api=api,
                              width=800,height=740,min_size=(580,540),hidden=not args.show,text_select=True,background_color="#f7f9f8")
    def hide():
        if not done.is_set():view.hide();return False
    view.events.closing+=hide
    def show():view.show()
    def pause():
        state=controller.status()
        result(lambda:controller.control("resume" if state.get("paused") else "pause"))
    def quit_node():
        reply=result(lambda:controller.control("shutdown"))
        if not reply["ok"]:
            view.show()
            view.evaluate_js("error("+json.dumps(reply["error"])+");")
            return
        done.set()
        icon.stop()
        for window in list(webview.windows):
            try:window.destroy()
            except Exception:pass
    # Authored application mark; no external assets or brand material.
    mark=Image.new("RGBA",(64,64),(0,0,0,0));draw=ImageDraw.Draw(mark)
    draw.rounded_rectangle((4,4,60,60),radius=12,fill="#226d5b")
    draw.ellipse((23,23,41,41),outline="white",width=3)
    for line in [((32,12),(32,18)),((32,46),(32,52)),((12,32),(18,32)),((46,32),(52,32)),((18,18),(22,22)),((42,42),(46,46)),((18,46),(22,42)),((42,22),(46,18))]:draw.line(line,fill="white",width=3)
    icon=pystray.Icon("AsterResearch",mark,"Aster · 本机科研节点",pystray.Menu(
        pystray.MenuItem("查看节点与论文",show,default=True),
        pystray.MenuItem("打开研究工作区",lambda:result(controller.open_web)),
        pystray.MenuItem(lambda item:"恢复处理" if controller.status().get("paused") else "暂停处理",pause),
        pystray.MenuItem("重新连接",lambda:result(lambda:controller.control("reconnect"))),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("停止本机服务并退出",quit_node)
    ))
    def run_background():
        if args.show:view.show()
        result(controller.start)
        threading.Thread(target=icon.run,daemon=True).start()
        failures=0
        while not done.wait(3):
            if (controller.data/"tray-open").exists():
                (controller.data/"tray-open").unlink(missing_ok=True);view.show()
            state=controller.status()
            if state.get("ok"):
                request=result(controller.reader_poll)
                item=request.get("value")
                if item:
                    opened=False;path=None;reader=None
                    try:
                        path=controller.reader_file(item["paperId"],item["indexVersion"])
                        if controller.reader_valid(item["id"]):
                            reader_files.add(path)
                            reader=webview.create_window("论文全文 · Aster",url=path.as_uri()+"#page="+str(item["page"]),width=1050,height=800,min_size=(640,480),text_select=True)
                            def clear_reader(path=path):
                                try:path.unlink(missing_ok=True);reader_files.discard(path)
                                except OSError:pass
                            reader.events.closed+=clear_reader
                            opened=reader.events.shown.wait(10)
                            if not opened:reader.destroy()
                        else:path.unlink(missing_ok=True)
                    except Exception:pass
                    if not opened and path:
                        try:path.unlink(missing_ok=True);reader_files.discard(path)
                        except OSError:pass
                    result(lambda:controller.reader_result(item["id"],opened))
            failures=0 if state.get("ok") else failures+1
            if failures>=10:result(controller.start);failures=0
            icon.title="Aster · "+("已连接" if state.get("connected") else "等待连接")
    try:
        webview.start(run_background,gui="edgechromium",private_mode=True,debug=False)
    finally:
        done.set()
        icon.stop()
        for path in list(reader_files):
            try:path.unlink(missing_ok=True)
            except OSError:pass
        kernel.CloseHandle.argtypes=[ctypes.c_void_p];kernel.CloseHandle(mutex)
if __name__=="__main__":main()
