import json
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from controller import Controller, LocalError
from readers import ReaderWindows

class Event:
    def __init__(self): self.handlers=[]
    def __iadd__(self, handler): self.handlers.append(handler);return self
    def fire(self):
        for handler in list(self.handlers):handler()
class Window:
    def __init__(self, closes=True):
        self.events=type("Events",(),{"closed":Event()})();self.closes=closes;self.destroyed=0
    def destroy(self):
        self.destroyed+=1
        if self.closes:self.events.closed.fire()

class ReaderDeletionTests(unittest.TestCase):
    def test_only_related_window_and_cache_are_removed_after_confirmed_close(self):
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/"node.json";config.write_text(json.dumps({"endpoint":"https://example.invalid","dataDir":directory}),encoding="utf8")
            controller=Controller(config);readers=ReaderWindows(controller)
            a,b=str(uuid.uuid4()),str(uuid.uuid4())
            with patch.object(controller,"request",return_value=b"%PDF-fixture"):
                first=controller.reader_file("paper","version",a);second=controller.reader_file("paper","version",b)
            primary=Window(False);unrelated=Window()
            readers.register(a,primary);readers.register(b,unrelated)
            self.assertFalse(readers.purge(a,timeout=0));self.assertTrue(first.exists());self.assertTrue(second.exists())
            primary.closes=True
            self.assertTrue(readers.purge(a,timeout=0));self.assertFalse(first.exists());self.assertTrue(second.exists())
            self.assertEqual(unrelated.destroyed,0);self.assertTrue(readers.purge(a,timeout=0))
            with self.assertRaises(LocalError):controller.purge_reader("../../private")
    def test_close_failure_and_file_lock_cannot_be_acknowledged(self):
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/"node.json";config.write_text(json.dumps({"endpoint":"https://example.invalid","dataDir":directory}),encoding="utf8")
            controller=Controller(config);readers=ReaderWindows(controller);identifier=str(uuid.uuid4())
            with patch.object(controller,"purge_reader",side_effect=PermissionError("locked")):
                self.assertFalse(readers.purge(identifier,timeout=0))
            window=Window();readers.register(identifier,window)
            with patch.object(window,"destroy",side_effect=RuntimeError("closing failed")):
                self.assertFalse(readers.purge(identifier,timeout=0))
    def test_startup_cleans_only_orphan_pdf_cache_inside_this_node(self):
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/"node.json";config.write_text(json.dumps({"endpoint":"https://example.invalid","dataDir":directory}),encoding="utf8")
            controller=Controller(config);cache=controller.reader_directory()
            (cache/"old.pdf").write_bytes(b"temporary");(cache/"keep.json").write_text("{}")
            original=Path(directory)/"original.pdf";original.write_bytes(b"original")
            controller.begin_tray()
            self.assertFalse((cache/"old.pdf").exists());self.assertTrue((cache/"keep.json").exists());self.assertEqual(original.read_bytes(),b"original")
            controller.end_tray()
    def test_cloud_purge_payload_is_ids_only_and_never_selects_a_path(self):
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/"node.json";config.write_text(json.dumps({"endpoint":"https://example.invalid","dataDir":directory}),encoding="utf8")
            controller=Controller(config);identifier=str(uuid.uuid4())
            with patch.object(controller,"request",return_value={"requestIds":[identifier],"path":"private"}) as request:
                self.assertEqual(controller.reader_purges(),[identifier]);request.assert_called_with("reader/purges",{})
            with patch.object(controller,"request",return_value={"requestIds":["../private"]}):
                with self.assertRaises(LocalError):controller.reader_purges()

if __name__=="__main__":unittest.main()
