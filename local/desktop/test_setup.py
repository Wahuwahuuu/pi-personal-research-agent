import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from setup import SetupController

class Capture(io.BytesIO):
    def close(self):self.captured=self.getvalue();super().close()
class Child:
    def __init__(self, lines):
        self.stdin=Capture();self.stdout=io.BytesIO(lines);self.code=0
    def wait(self,timeout=None):return self.code
    def poll(self):return self.code
    def kill(self):self.code=-1
class SetupTests(unittest.TestCase):
    def controller(self,temp):
        node=Path(temp)/"node.exe";node.write_text("synthetic")
        return SetupController(node,Path(temp)/"node.json")
    def test_credential_only_crosses_stdin_and_child_environment_is_restricted(self):
        with tempfile.TemporaryDirectory() as temp:
            c=self.controller(temp);child=Child(b'{"phase":"pairing"}\n{"ok":true,"value":{"configured":true}}\n')
            def start(args,**kwargs):
                self.assertNotIn("synthetic-device",str(args));self.assertNotIn("MODEL_API_KEY",kwargs["env"])
                self.assertNotIn("PIPAPER_API_KEY",kwargs["env"]);return child
            with patch.dict(os.environ,{"MODEL_API_KEY":"private","PIPAPER_API_KEY":"private"}),patch("setup.subprocess.Popen",side_effect=start):
                result=c.request("install",{"endpoint":"https://example.invalid"},"synthetic-device")
            self.assertTrue(result["ok"]);self.assertEqual(json.loads(child.stdin.captured)["credential"],"synthetic-device")
            self.assertEqual(c.progress(),{"busy":False,"phase":""})
    def test_unknown_actions_and_concurrent_actions_never_spawn_commands(self):
        with tempfile.TemporaryDirectory() as temp,patch("setup.subprocess.Popen") as popen:
            c=self.controller(temp);self.assertFalse(c.request("run_shell")["ok"])
            c.lock.acquire()
            try:self.assertEqual(c.request("check")["error"],"SETUP_BUSY")
            finally:c.lock.release()
            popen.assert_not_called()
    def test_raw_errors_do_not_reach_bridge_and_owned_lock_is_released(self):
        with tempfile.TemporaryDirectory() as temp,patch("setup.subprocess.Popen",side_effect=RuntimeError("private credential and path")):
            c=self.controller(temp);result=c.request("check",{})
            self.assertEqual(result,{"ok":False,"error":"SETUP_ACTION_FAILED"});self.assertFalse(c.lock.locked())
if __name__=="__main__":unittest.main()
