"""Local-only import journal and atomic publication over the existing P2 indexer."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
from urllib.request import Request, build_opener
from uuid import uuid4
from .scientific_reading import SafeRedirect
from .p2 import build_index, verify_artifacts, load_source

MAX_PDF = 64 * 1024 * 1024
TERMINAL = {"published", "failed", "cancelled"}

class LibraryError(ValueError):
    pass

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")

def sha(data):
    return hashlib.sha256(data).hexdigest()

def atomic(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise LibraryError("UNSAFE_LIBRARY_PATH")
    temporary = path.with_name(path.name + "." + uuid4().hex + ".tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)

def metadata(value):
    value = value or {}
    if not isinstance(value, dict) or set(value) - {"title", "authors", "abstract"}:
        raise LibraryError("INVALID_METADATA")
    result = {}
    for key, limit in (("title", 2000), ("authors", 4000), ("abstract", 20000)):
        text = value.get(key, "")
        if not isinstance(text, str) or len(text) > limit or "\0" in text:
            raise LibraryError("INVALID_METADATA")
        result[key] = text.strip()
    return result

def extract_pdf(path: Path, paper_id: str, meta: dict):
    from pypdf import PdfReader
    reader = PdfReader(path, strict=False)
    if reader.is_encrypted:
        raise LibraryError("ENCRYPTED_PDF_UNSUPPORTED")
    if not 1 <= len(reader.pages) <= 1000:
        raise LibraryError("PDF_PAGE_LIMIT")
    sections, gaps, total = [], [], 0
    for number, page in enumerate(reader.pages, 1):
        content = page.get_contents()
        if content and len(content.get_data()) > 10 * 1024 * 1024:
            raise LibraryError("PDF_PAGE_CONTENT_LIMIT")
        text = page.extract_text() or ""
        text = text.replace("\0", "")
        if len(text) > 1000000:
            raise LibraryError("PDF_PAGE_TEXT_LIMIT")
        total += len(text)
        if total > 8000000:
            raise LibraryError("PDF_TEXT_LIMIT")
        if not text.strip():
            gaps.append(number)
        # Every paragraph remains an exact span in the extracted page text.
        sections.append({"section_name": "Page " + str(number), "paragraphs": [text]})
    if len(gaps) == len(reader.pages):
        raise LibraryError("TEXT_LAYER_REQUIRED")
    title = meta["title"] or str((reader.metadata or {}).get("/Title") or paper_id).strip()
    return {
        "paper": {"paper_id": paper_id, "title": title[:2000], "abstract": meta["abstract"], "full_text": sections},
        "metadata": {**meta, "title": title[:2000], "pages": len(reader.pages),
                     "unreadablePages": gaps, "coverage": "partial" if gaps else "text",
                     "parser": "pypdf-7.0.1", "structure": "page-text"},
    }

def download_arxiv(identifier: str, target: Path, cancelled=lambda: None):
    if not re.fullmatch(r"\d{4}\.\d{4,5}v[1-9]\d{0,3}", identifier):
        raise LibraryError("VERSIONED_ARXIV_ID_REQUIRED")
    request = Request("https://arxiv.org/pdf/" + identifier,
                      headers={"User-Agent": "PersonalResearchAgent/1.0 (personal paper library)", "Accept": "application/pdf"})
    with build_opener(SafeRedirect()).open(request, timeout=20) as response:
        parts, total = [], 0
        while True:
            cancelled()
            part = response.read(65536)
            if not part:
                break
            total += len(part)
            if total > MAX_PDF:
                raise LibraryError("PDF_SIZE_LIMIT")
            parts.append(part)
    data = b"".join(parts)
    if not data.startswith(b"%PDF-"):
        raise LibraryError("PDF_REQUIRED")
    atomic(target, data)

class Library:
    def __init__(self, root: Path):
        if not root.is_absolute():
            raise LibraryError("ABSOLUTE_LIBRARY_ROOT_REQUIRED")
        root.mkdir(parents=True, exist_ok=True)
        self.root = root.resolve(strict=True)
        self.db = sqlite3.connect(self.path("library.sqlite"), timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        if self.db.execute("PRAGMA user_version").fetchone()[0] not in {0, 1, 2}:
            raise LibraryError("LIBRARY_SCHEMA_UNSUPPORTED")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, source TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
          status TEXT NOT NULL, error TEXT, cancel INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL,
          updated REAL NOT NULL, paper_id TEXT, version TEXT);
        CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, digest TEXT NOT NULL, job_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS papers(id TEXT PRIMARY KEY, sha TEXT UNIQUE NOT NULL, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS versions(version TEXT PRIMARY KEY, descriptor TEXT NOT NULL, paper_ids TEXT NOT NULL);
        """)
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            if "attempts" not in {row[1] for row in self.db.execute("PRAGMA table_info(jobs)")}:
                self.db.execute("ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
            self.db.execute("PRAGMA user_version=2")

    def path(self, relative: str):
        target = self.root / relative
        if not target.resolve().is_relative_to(self.root) or target.is_symlink():
            raise LibraryError("UNSAFE_LIBRARY_PATH")
        return target

    def close(self):
        self.db.close()

    @contextmanager
    def exclusive(self):
        path = self.path("processing.lock")
        with path.open("a+b") as lock:
            lock.seek(0)
            if os.fstat(lock.fileno()).st_size == 0:
                lock.write(b"0")
                lock.flush()
            lock.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise LibraryError("LIBRARY_BUSY") from error
            try:
                yield
            finally:
                lock.seek(0)
                if os.name == "nt":
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def job(self, identifier):
        row = self.db.execute("SELECT * FROM jobs WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise LibraryError("UNKNOWN_IMPORT")
        return dict(row)

    def jobs(self, limit=100):
        if type(limit) is not int or not 1 <= limit <= 200:
            raise LibraryError("INVALID_PAGE_LIMIT")
        # No selected local filename or arbitrary path is persisted or returned.
        return [dict(r) for r in self.db.execute(
            "SELECT id,source,status,error,created,updated,paper_id,version FROM jobs ORDER BY status IN ('published','failed','cancelled'),created ASC LIMIT ?", (limit,))]

    def _register(self, request_id, source, payload):
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 200:
            raise LibraryError("INVALID_REQUEST_ID")
        digest = sha(canonical({"source": source, "metadata": payload["metadata"]}))
        with self.db:
            previous = self.db.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
            if previous:
                if previous["digest"] != digest:
                    raise LibraryError("IDEMPOTENCY_CONFLICT")
                return self.job(previous["job_id"])
            previous = self.db.execute("SELECT id FROM jobs WHERE source=?", (source,)).fetchone()
            identifier = previous["id"] if previous else uuid4().hex
            if not previous:
                now = time.time()
                self.db.execute("INSERT INTO jobs(id,source,payload,status,created,updated) VALUES(?,?,?,'queued',?,?)",
                                (identifier, source, canonical(payload).decode(), now, now))
            self.db.execute("INSERT INTO requests VALUES(?,?,?)", (request_id, digest, identifier))
        return self.job(identifier)

    def register_pdf(self, request_id, selected: Path, values=None):
        # Called only from the trusted local picker/CLI, never with a cloud-supplied path.
        if not selected.is_absolute() or selected.is_symlink() or not selected.is_file():
            raise LibraryError("LOCAL_PDF_REQUIRED")
        if selected.stat().st_size > MAX_PDF:
            raise LibraryError("PDF_SIZE_LIMIT")
        data = selected.read_bytes()
        if len(data) > MAX_PDF or not data.startswith(b"%PDF-"):
            raise LibraryError("PDF_REQUIRED")
        digest = sha(data)
        target = self.path("objects/" + digest + ".pdf")
        if target.exists() and sha(target.read_bytes()) != digest:
            raise LibraryError("LIBRARY_OBJECT_CHANGED")
        if not target.exists():
            atomic(target, data)
        return self._register(request_id, "sha256:" + digest, {
            "kind": "pdf", "sha": digest, "metadata": metadata(values)})

    def register_arxiv(self, request_id, identifier, values=None):
        if not isinstance(identifier, str) or not re.fullmatch(r"\d{4}\.\d{4,5}v[1-9]\d{0,3}", identifier):
            raise LibraryError("VERSIONED_ARXIV_ID_REQUIRED")
        return self._register(request_id, "arxiv:" + identifier, {
            "kind": "arxiv", "arxiv": identifier, "metadata": metadata(values)})

    def cancel(self, identifier):
        with self.db:
            row = self.job(identifier)
            if row["status"] not in TERMINAL:
                self.db.execute("UPDATE jobs SET cancel=1,status='cancelled',updated=? WHERE id=?", (time.time(), identifier))
        return self.job(identifier)

    def retry(self, identifier):
        with self.db:
            row = self.job(identifier)
            if row["status"] not in {"failed", "cancelled"}:
                raise LibraryError("IMPORT_NOT_RETRYABLE")
            self.db.execute("UPDATE jobs SET cancel=0,status='queued',error=NULL,attempts=0,updated=? WHERE id=?", (time.time(), identifier))
        return self.job(identifier)

    def mark_failure(self, identifier, code):
        if code not in {"IMPORT_PROCESS_INTERRUPTED", "IMPORT_TIMEOUT"}:
            raise LibraryError("INVALID_FAILURE_CODE")
        with self.db:
            row = self.job(identifier)
            if row["status"] not in TERMINAL:
                self.db.execute("UPDATE jobs SET status='failed',error=?,updated=? WHERE id=?", (code, time.time(), identifier))
        return self.job(identifier)

    def check_cancel(self, identifier):
        if self.job(identifier)["cancel"]:
            raise LibraryError("CANCELLED")

    def stage(self, identifier, value):
        with self.db:
            self.check_cancel(identifier)
            self.db.execute("UPDATE jobs SET status=?,error=NULL,updated=? WHERE id=?", (value, time.time(), identifier))

    def active(self, verifier=verify_artifacts):
        pointer = self.path("active.json")
        if not pointer.exists():
            return None
        descriptor = json.loads(pointer.read_bytes())
        saved = self.db.execute("SELECT descriptor FROM versions WHERE version=?", (descriptor["version"],)).fetchone()
        if not saved:
            raise LibraryError("UNREGISTERED_INDEX")
        registered = json.loads(saved["descriptor"])
        if {k: v for k, v in registered.items() if k != "job_id"} != {k: v for k, v in descriptor.items() if k != "job_id"}:
            raise LibraryError("UNREGISTERED_INDEX")
        self.job(descriptor["job_id"])
        index, corpus = self.path(descriptor["index"]), self.path(descriptor["corpus"])
        if sha((index / "index-manifest.json").read_bytes()) != descriptor["manifest_sha"]:
            raise LibraryError("INDEX_MANIFEST_CHANGED")
        if verifier(index, corpus)["index_version"] != descriptor["version"]:
            raise LibraryError("INDEX_VERSION_CHANGED")
        return descriptor

    def _finish_publication(self, descriptor):
        identifier = descriptor["job_id"]
        row = self.job(identifier)
        payload = json.loads(row["payload"])
        record_path = "records/" + payload["sha"] + ".json"
        record = json.loads(self.path(record_path).read_bytes())
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO papers VALUES(?,?,?)",
                            (record["paper"]["paper_id"], payload["sha"], record_path))
            self.db.execute("UPDATE jobs SET status='published',error=NULL,version=?,paper_id=?,updated=? WHERE id=?",
                            (descriptor["version"], record["paper"]["paper_id"], time.time(), identifier))

    def recover(self, verifier=verify_artifacts):
        active = self.active(verifier)
        if active and self.job(active["job_id"])["status"] != "published":
            self._finish_publication(active)
        return active

    def rollback(self, version, verifier=verify_artifacts):
        with self.exclusive():
            row = self.db.execute("SELECT descriptor FROM versions WHERE version=?", (version,)).fetchone()
            if not row:
                raise LibraryError("UNKNOWN_INDEX_VERSION")
            descriptor = json.loads(row["descriptor"])
            if verifier(self.path(descriptor["index"]), self.path(descriptor["corpus"]))["index_version"] != version:
                raise LibraryError("INDEX_VERSION_CHANGED")
            atomic(self.path("active.json"), canonical(descriptor))
            self._finish_publication(descriptor)
            return self.active(verifier)

    def run_one(self, models: Path, device="cuda", builder=build_index, verifier=verify_artifacts,
                parser=extract_pdf, downloader=download_arxiv, hook=lambda _: None, base_corpus: Path | None = None):
        if device not in {"cpu", "cuda"} or not models.is_absolute():
            raise LibraryError("INVALID_MODEL_CONFIG")
        if base_corpus is not None and not base_corpus.is_absolute():
            raise LibraryError("ABSOLUTE_BASE_CORPUS_REQUIRED")
        with self.exclusive():
            self.recover(verifier)
            row = self.db.execute("SELECT id FROM jobs WHERE status NOT IN ('published','failed','cancelled') ORDER BY created LIMIT 1").fetchone()
            if not row:
                return None
            identifier = row["id"]
            with self.db:
                if self.job(identifier)["attempts"] >= 3:
                    self.db.execute("UPDATE jobs SET status='failed',error='IMPORT_RETRY_LIMIT',updated=? WHERE id=?", (time.time(), identifier))
                    return self.job(identifier)
                self.db.execute("UPDATE jobs SET attempts=attempts+1 WHERE id=?", (identifier,))
            try:
                payload = json.loads(self.job(identifier)["payload"])
                self.stage(identifier, "acquiring")
                if not payload.get("sha"):
                    incoming = self.path("incoming/" + identifier + ".pdf")
                    downloader(payload["arxiv"], incoming, lambda: self.check_cancel(identifier))
                    data = incoming.read_bytes()
                    if len(data) > MAX_PDF or not data.startswith(b"%PDF-"):
                        raise LibraryError("PDF_REQUIRED")
                    payload["sha"] = sha(data)
                    atomic(self.path("objects/" + payload["sha"] + ".pdf"), data)
                    with self.db:
                        self.db.execute("UPDATE jobs SET payload=? WHERE id=?", (canonical(payload).decode(), identifier))
                    incoming.unlink(missing_ok=True)
                digest = payload["sha"]
                pdf = self.path("objects/" + digest + ".pdf")
                if sha(pdf.read_bytes()) != digest:
                    raise LibraryError("LIBRARY_OBJECT_CHANGED")
                duplicate = self.db.execute("SELECT id FROM papers WHERE sha=?", (digest,)).fetchone()
                active = self.active(verifier)
                active_ids = json.loads(self.db.execute("SELECT paper_ids FROM versions WHERE version=?", (active["version"],)).fetchone()[0]) if active else []
                if duplicate and duplicate["id"] in active_ids:
                    with self.db:
                        self.db.execute("UPDATE jobs SET status='published',paper_id=?,version=?,updated=? WHERE id=?",
                                        (duplicate["id"], self.active(verifier)["version"], time.time(), identifier))
                    return self.job(identifier)
                self.stage(identifier, "parsing")
                baseline = load_source(base_corpus)[0] if base_corpus is not None else []
                paper_id = duplicate["id"] if duplicate else payload.get("arxiv") or "local-" + digest
                if not duplicate and paper_id.endswith("v1") and any(p["paper_id"] == paper_id[:-2] for p in baseline):
                    paper_id = paper_id[:-2]
                record_path = self.path("records/" + digest + ".json")
                record = json.loads(record_path.read_bytes()) if duplicate else parser(pdf, paper_id, payload["metadata"])
                if record["paper"]["paper_id"] != paper_id:
                    raise LibraryError("PARSER_IDENTITY_CHANGED")
                record_path = self.path("records/" + digest + ".json")
                atomic(record_path, canonical(record))
                hook("parsed")
                by_id = {paper["paper_id"]: paper for paper in baseline}
                for row in self.db.execute("SELECT record FROM papers ORDER BY id"):
                    stored = json.loads(self.path(row["record"]).read_bytes())["paper"]
                    by_id[stored["paper_id"]] = stored
                by_id[paper_id] = record["paper"]
                papers = sorted(by_id.values(), key=lambda p: p["paper_id"])
                content = b"\n".join(canonical(p) for p in papers) + b"\n"
                snapshot_id = sha(content)
                corpus = self.path("snapshots/" + snapshot_id + "/corpus")
                manifest = {"index_version": "library-source-" + snapshot_id, "paper_count": len(papers),
                            "papers": [{"paper_id": p["paper_id"]} for p in papers],
                            "files": {"papers.jsonl": sha(content)}}
                for path, data in ((corpus / "papers.jsonl", content),
                                   (corpus.parent / "manifests/corpus.json", canonical(manifest))):
                    if path.exists() and path.read_bytes() != data:
                        raise LibraryError("IMMUTABLE_SNAPSHOT_CHANGED")
                    if not path.exists():
                        atomic(path, data)
                self.stage(identifier, "indexing")
                # Each interrupted build has a separate workspace; published indexes are never overwritten.
                build_root = self.path("builds/" + identifier + "/" + uuid4().hex)
                index = builder(corpus, models, build_root, device=device, full=True, multilingual=True)
                index = Path(index).resolve(strict=True)
                if not index.is_relative_to(build_root):
                    raise LibraryError("INDEX_ESCAPED_BUILD")
                self.stage(identifier, "validating")
                built = verifier(index, corpus)
                hook("validated")
                descriptor = {"version": built["index_version"], "index": index.relative_to(self.root).as_posix(),
                              "corpus": corpus.relative_to(self.root).as_posix(), "job_id": identifier,
                              "manifest_sha": sha((index / "index-manifest.json").read_bytes())}
                prior = self.db.execute("SELECT descriptor FROM versions WHERE version=?", (descriptor["version"],)).fetchone()
                if prior:
                    descriptor = {**json.loads(prior["descriptor"]), "job_id": identifier}
                    verifier(self.path(descriptor["index"]), self.path(descriptor["corpus"]))
                with self.db:
                    self.db.execute("INSERT OR IGNORE INTO versions VALUES(?,?,?)", (
                        descriptor["version"], canonical(descriptor).decode(), canonical([p["paper_id"] for p in papers]).decode()))
                # Registration precedes the atomic pointer. A crash after replace is completed by recover().
                with self.db:
                    self.db.execute("BEGIN IMMEDIATE")
                    self.check_cancel(identifier)
                    atomic(self.path("active.json"), canonical(descriptor))
                    hook("pointer_replaced")
                    self._finish_publication(descriptor)
                return self.job(identifier)
            except Exception as error:
                code = str(error) if isinstance(error, LibraryError) else "IMPORT_FAILED"
                code = code if re.fullmatch(r"[A-Z_]{1,80}", code) else "IMPORT_FAILED"
                with self.db:
                    cancelled = self.job(identifier)["cancel"] or code == "CANCELLED"
                    self.db.execute("UPDATE jobs SET status=?,error=?,updated=? WHERE id=?",
                                    ("cancelled" if cancelled else "failed", code, time.time(), identifier))
                return self.job(identifier)

def main():
    parser = argparse.ArgumentParser(description="Local library control; never expose this CLI as a remote shell.")
    parser.add_argument("--root", required=True, type=Path)
    args = parser.parse_args()
    library = Library(args.root)
    try:
        value = json.loads(sys.stdin.read(24000))
        action = value.pop("action")
        if action == "register_pdf":
            result = library.register_pdf(value["requestId"], Path(value["path"]), value.get("metadata"))
        elif action == "register_arxiv":
            result = library.register_arxiv(value["requestId"], value["arxivId"], value.get("metadata"))
        elif action == "run":
            result = library.run_one(Path(value["models"]), value.get("device", "cuda"), base_corpus=Path(value["baseCorpus"]) if value.get("baseCorpus") else None)
        elif action == "cancel":
            result = library.cancel(value["id"])
        elif action == "mark_failure":
            result = library.mark_failure(value["id"], value["code"])
        elif action == "retry":
            result = library.retry(value["id"])
        elif action == "status":
            result = library.job(value["id"])
        elif action == "list":
            result = library.jobs(value.get("limit", 100))
        elif action == "active":
            result = library.active()
        elif action == "rollback":
            result = library.rollback(value["version"])
        else:
            raise LibraryError("ACTION_DENIED")
        # Full text and selected filesystem paths are never returned on the command channel.
        if isinstance(result, dict):
            result.pop("payload", None)
        print(json.dumps({"result": result}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error) if isinstance(error, LibraryError) else "LIBRARY_COMMAND_FAILED"}))
        return 1
    finally:
        library.close()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
