import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from controller import Controller, LocalError, safe_environment, safe_endpoint

class ControllerTests(unittest.TestCase):
    def test_starting_node_is_not_reported_as_stopped_or_given_control_permissions(self):
        from io import BytesIO
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"node.json";path.write_text(json.dumps({"endpoint":"https://cloud.example","dataDir":temp}),encoding="utf8")
            c=Controller(path)
            for valid in (True,False):
                value={"instanceId":c.control_directory.name if valid else "other","apiReady":False,"application":{"build":"a"*40}}
                with patch.object(c,"request",side_effect=LocalError("LOCAL_REQUEST_FAILED")),patch.object(c._http,"open",return_value=BytesIO(json.dumps(value).encode())):
                    state=c.status()
                    self.assertFalse(state["ok"])
                    self.assertEqual(state["phase"],"loading" if valid else "stopped")
                    self.assertEqual(state.get("starting",False),valid)


    def test_start_awaits_existing_initializing_node_without_spawning_a_duplicate(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"node.json";path.write_text(json.dumps({"endpoint":"https://cloud.example","dataDir":temp}),encoding="utf8")
            c=Controller(path)
            with patch.object(c,"status",return_value={"ok":False,"starting":True,"phase":"loading"}),patch("controller.subprocess.Popen") as spawn:
                self.assertEqual(c.start(),{"accepted":True,"existing":True,"starting":True})
                spawn.assert_not_called()
            with patch.object(c,"status",return_value={"ok":False,"phase":"stopped"}),patch("controller.shutil.which",return_value="node.exe"),patch("controller.subprocess.Popen") as spawn:
                self.assertEqual(c.start(),{"accepted":True,"starting":True})
                spawn.assert_called_once()

    def test_browser_bridge_cannot_supply_arbitrary_web_endpoints_or_commands(self):
        for value in ["file:///C:/private", "http://remote.example", "https://token@host/path", "https://host/?token=secret"]:
            with self.assertRaises(LocalError):safe_endpoint(value)
        self.assertEqual(safe_endpoint("https://host.example/"),"https://host.example")
    def test_child_environment_strips_cloud_credentials(self):
        with patch.dict(os.environ,{"MODEL_API_KEY":"synthetic-secret","PIPAPER_API_KEY":"synthetic-secret","PRA_DEVICE_TOKEN":"synthetic-secret","PATH":"system-path"},clear=True):
            self.assertEqual(safe_environment(),{"PATH":"system-path"})
    def test_control_is_allowlisted_and_diagnostics_remove_titles_paths_and_secrets(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"node.json"
            path.write_text(json.dumps({"endpoint":"https://cloud.example","dataDir":temp}),encoding="utf8")
            controller=Controller(path)
            with self.assertRaises(LocalError):controller.control("run_shell")
            with self.assertRaises(LocalError):controller.import_arxiv("../../private")
            with self.assertRaises(LocalError):controller.import_arxiv("2401.00001")
            state={"ok":True,"connected":True,"ready":True,"phase":"ready","indexVersion":"test-index","secret":"hidden","path":"private","imports":[{"status":"failed","title":"private title","payload":"private"}]}
            with patch.object(controller,"status",return_value=state):
                exported=json.dumps(controller.diagnostics())
                self.assertNotIn("hidden",exported);self.assertNotIn("private",exported)
                self.assertEqual(controller.diagnostics()["importStates"]["failed"],1)
    def test_private_reader_fetch_uses_only_registered_identity_not_a_filesystem_path(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"node.json";path.write_text(json.dumps({"endpoint":"https://cloud.example","dataDir":temp}),encoding="utf8")
            controller=Controller(path)
            def request(route,**kwargs):
                self.assertEqual(route,"pdf?paperId=local-registered&indexVersion=version")
                self.assertTrue(kwargs["binary"])
                return b"%PDF-synthetic"
            with patch.object(controller,"request",side_effect=request):
                file=controller.reader_file("local-registered","version")
                self.assertTrue(file.resolve().is_relative_to(Path(temp).resolve()))
                self.assertEqual(file.read_bytes(),b"%PDF-synthetic")

    def test_reader_handoff_strips_paths_and_checks_native_page_bounds(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"node.json";path.write_text(json.dumps({"endpoint":"https://cloud.example","dataDir":temp}),encoding="utf8")
            controller=Controller(path)
            item={"id":"request","paperId":"paper","indexVersion":"version","page":3,"path":"private/path","command":"shell"}
            with patch.object(controller,"request",return_value=item):
                self.assertEqual(controller.reader_poll(),{k:item[k] for k in ("id","paperId","indexVersion","page")})
            for page in (0,1001,True,"3"):
                with patch.object(controller,"request",return_value={**item,"page":page}):
                    with self.assertRaises(LocalError):controller.reader_poll()
            with patch.object(controller,"request",return_value={"valid":False}):
                self.assertFalse(controller.reader_valid("request"))

    def test_intentional_stop_blocks_recovery_until_a_new_tray_session(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"node.json";path.write_text(json.dumps({"endpoint":"https://cloud.example","dataDir":temp}),encoding="utf8")
            c=Controller(path);c.begin_tray()
            receipt=json.loads((c.control_directory/"tray.json").read_text(encoding="utf8"))
            self.assertEqual(receipt["pid"],os.getpid())
            (c.control_directory/"stop").write_text("{}",encoding="utf8")
            self.assertTrue(c.stop_requested())
            with patch.object(c,"status") as status:
                with self.assertRaisesRegex(LocalError,"LOCAL_STOP_REQUESTED"):c.start()
                status.assert_not_called()
            c.end_tray()
            self.assertFalse((c.control_directory/"tray.json").exists())
            c.begin_tray();self.assertFalse(c.stop_requested());c.end_tray()

    def test_tray_cleanup_never_removes_a_newer_session_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"node.json";path.write_text(json.dumps({"endpoint":"https://cloud.example","dataDir":temp}),encoding="utf8")
            a=Controller(path);b=Controller(path)
            a.begin_tray();b.begin_tray();a.end_tray()
            self.assertTrue((b.control_directory/"tray.json").exists())
            b.end_tray()
            other=Path(temp)/"other.json";other.write_text(path.read_text(encoding="utf8"),encoding="utf8")
            self.assertNotEqual(a.control_directory,Controller(other).control_directory)

if __name__=="__main__":unittest.main()
