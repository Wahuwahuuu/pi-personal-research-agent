"""Own only windows opened for a specific cloud request; never inspect other windows."""
from __future__ import annotations
import threading

class ReaderWindows:
    def __init__(self, controller):
        self.controller = controller
        self._windows = {}
        self._lock = threading.RLock()

    def register(self, identifier, window):
        closed = threading.Event()
        record = (window, closed)
        with self._lock:
            if identifier in self._windows:
                raise RuntimeError("DUPLICATE_READER_WINDOW")
            self._windows[identifier] = record
        def on_closed():
            closed.set()
            with self._lock:
                if self._windows.get(identifier) is record:
                    self._windows.pop(identifier)
            try:
                self.controller.purge_reader(identifier)
            except Exception:
                pass  # A cloud deletion remains pending until a later successful unlink.
        window.events.closed += on_closed

    def purge(self, identifier, timeout=5):
        with self._lock:
            record = self._windows.get(identifier)
        if record:
            window, closed = record
            try:
                window.destroy()
            except Exception:
                return False
            if not closed.wait(timeout):
                return False
        try:
            self.controller.purge_reader(identifier)
            return True
        except Exception:
            return False
