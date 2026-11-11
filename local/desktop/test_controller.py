import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from controller import Controller, LocalError, safe_environment, safe_endpoint

class ControllerTests(unittest.TestCase):
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

if __name__=="__main__":unittest.main()
