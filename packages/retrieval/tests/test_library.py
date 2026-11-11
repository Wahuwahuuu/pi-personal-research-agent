import json
from pathlib import Path
import tempfile
import unittest
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from retriever.library import Library, LibraryError, extract_pdf, canonical, sha
from retriever.p2 import load_source, tokenize_library, tokenize_bm25, library_recipe, full_recipe, P2Corpus

def pdf(path, texts):
    writer = PdfWriter()
    for text in texts:
        page = writer.add_blank_page(600, 800)
        if text is not None:
            font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
                                     NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
            page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
            escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            stream = DecodedStreamObject()
            stream.set_data(("BT /F1 12 Tf 50 700 Td (" + escaped + ") Tj ET").encode("ascii"))
            page[NameObject("/Contents")] = writer._add_object(stream)
    with path.open("wb") as out:
        writer.write(out)

def build(corpus, models, target, **kwargs):
    # Publication fault tests isolate the real source manifest from GPU computation.
    load_source(corpus)
    digest = sha((corpus / "papers.jsonl").read_bytes())
    folder = target / ("fixture-" + digest[:16])
    folder.mkdir(parents=True)
    (folder / "index-manifest.json").write_bytes(canonical({"index_version": folder.name, "source": digest}))
    return folder

def verify(index, corpus):
    data = json.loads((index / "index-manifest.json").read_bytes())
    if data["source"] != sha((corpus / "papers.jsonl").read_bytes()):
        raise LibraryError("SOURCE_CHANGED")
    load_source(corpus)
    return data

class SimulatedPowerLoss(BaseException):
    pass

class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pra-library-")
        self.root = Path(self.tmp.name)
        self.library = Library(self.root / "library")
        self.first = self.root / "first.pdf"
        self.second = self.root / "second.pdf"
        pdf(self.first, ["Research evidence: sample score 89.2."])
        pdf(self.second, ["Independent research evidence: sample score 90.1."])

    def tearDown(self):
        self.library.close()
        self.tmp.cleanup()

    def run_job(self, **kwargs):
        return self.library.run_one(self.root, "cpu", builder=build, verifier=verify, **kwargs)

    def test_dynamic_library_search_supports_chinese_without_changing_legacy_tokens(self):
        self.assertEqual(tokenize_bm25("中文检索"), [])
        self.assertIn("检索", tokenize_library("中文检索"))
        self.assertIn("ai", tokenize_library("ＡＩ 中文检索"))
        settings = library_recipe("cpu")
        self.assertEqual(settings["window_policy"], full_recipe("cpu")["window_policy"])
        self.assertNotEqual(settings["recipe_version"], full_recipe("cpu")["recipe_version"])
        corpus = P2Corpus([{"paper_id":"p1","title":"中文科研检索","abstract":"实验结论"},
                           {"paper_id":"p2","title":"不相关资料","abstract":""}],
                          [], None, None, {"index_version":"library-fixture","identity":{"recipe":settings}}, None, "bm25")
        self.assertEqual(corpus.search_papers({"query":"科研检索"})["papers"][0]["paper_id"], "p1")

    def test_real_text_pdf_preserves_pages_and_explicit_blank_coverage(self):
        mixed = self.root / "mixed.pdf"
        pdf(mixed, ["Page one evidence.", None, "Page three evidence."])
        row = self.library.register_pdf("mixed", mixed, {"title": "Known title"})
        self.assertEqual(self.run_job()["status"], "published")
        record = json.loads(next((self.root / "library/records").glob("*.json")).read_bytes())
        self.assertEqual(record["metadata"]["unreadablePages"], [2])
        self.assertEqual(record["metadata"]["coverage"], "partial")
        self.assertEqual(record["paper"]["full_text"][2]["section_name"], "Page 3")
        active = self.library.active(verify)
        papers, paragraphs, manifest = load_source(self.library.path(active["corpus"]))
        self.assertEqual(papers[0]["title"], "Known title")
        self.assertTrue(any(p["text"] == "Page three evidence." for p in paragraphs.values()))

    def test_new_library_keeps_the_configured_base_papers_without_mutating_them(self):
        self.library.register_pdf("base", self.first)
        self.run_job()
        active = self.library.active(verify)
        corpus = self.library.path(active["corpus"])
        before = (corpus / "papers.jsonl").read_bytes()
        other = Library(self.root / "second-library")
        try:
            other.register_pdf("new", self.second)
            self.assertEqual(other.run_one(self.root, "cpu", builder=build, verifier=verify, base_corpus=corpus)["status"], "published")
            combined = other.active(verify)
            self.assertEqual(len(load_source(other.path(combined["corpus"]))[0]), 2)
            self.assertEqual((corpus / "papers.jsonl").read_bytes(), before)
        finally:
            other.close()

    def test_request_and_content_idempotence_and_conflict(self):
        a = self.library.register_pdf("same", self.first)
        self.assertEqual(a["id"], self.library.register_pdf("same", self.first)["id"])
        copied = self.root / "copy.pdf"
        copied.write_bytes(self.first.read_bytes())
        self.assertEqual(a["id"], self.library.register_pdf("other-request", copied)["id"])
        with self.assertRaisesRegex(LibraryError, "IDEMPOTENCY_CONFLICT"):
            self.library.register_pdf("same", self.second)
        self.assertEqual(len(self.library.jobs()), 1)
        self.assertNotIn(str(self.first), json.dumps(self.library.job(a["id"])))

    def test_scanned_pdf_never_becomes_a_successful_reading(self):
        scan = self.root / "scan.pdf"
        pdf(scan, [None])
        self.library.register_pdf("scan", scan)
        result = self.run_job()
        self.assertEqual(result["error"], "TEXT_LAYER_REQUIRED")
        self.assertEqual(result["status"], "failed")
        self.assertIsNone(self.library.active(verify))

    def test_remote_import_accepts_only_versioned_source_identity(self):
        for invalid in ["https://example.org/file.pdf", "../secret", "2401.12345", "2401.12345v0", "2401.12345v1?secret=x"]:
            with self.assertRaises(LibraryError):
                self.library.register_arxiv("invalid", invalid)
        source = self.library.register_arxiv("arxiv", "2401.12345v2", {"title": "Version two"})
        called = []
        def download(identifier, target, cancelled):
            called.append(identifier); cancelled()
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(self.first.read_bytes())
        result = self.run_job(downloader=download)
        self.assertEqual(called, ["2401.12345v2"])
        self.assertEqual(result["paper_id"], "2401.12345v2")
        self.assertEqual(result["status"], "published")

    def test_cross_source_duplicates_do_not_duplicate_papers_or_index_build(self):
        self.library.register_pdf("local", self.first)
        first = self.run_job()
        self.library.register_arxiv("remote", "2401.12345v1")
        def download(_, target, cancelled):
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(self.first.read_bytes())
        second = self.run_job(downloader=download)
        self.assertEqual(second["paper_id"], first["paper_id"])
        self.assertEqual(second["version"], first["version"])
        self.assertEqual(self.library.db.execute("SELECT COUNT(*) FROM papers").fetchone()[0], 1)

    def test_failed_build_preserves_previous_index_and_retry_keeps_old_snapshot(self):
        self.library.register_pdf("first", self.first)
        self.run_job()
        old = self.library.active(verify)
        original = self.library.path(old["corpus"]).joinpath("papers.jsonl").read_bytes()
        second = self.library.register_pdf("second", self.second)
        def fail(*args, **kwargs):
            raise RuntimeError("Unpublished build failure")
        result = self.library.run_one(self.root, "cpu", builder=fail, verifier=verify)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.library.active(verify), old)
        self.library.retry(second["id"])
        self.assertEqual(self.run_job()["status"], "published")
        self.assertNotEqual(self.library.active(verify)["version"], old["version"])
        self.assertEqual(self.library.path(old["corpus"]).joinpath("papers.jsonl").read_bytes(), original)
        self.library.rollback(old["version"], verify)
        self.assertEqual(self.library.active(verify), old)

    def test_cancel_during_build_never_publishes_late_index(self):
        row = self.library.register_pdf("cancel", self.first)
        def cancelling(*args, **kwargs):
            other = Library(self.library.root)
            try:
                other.cancel(row["id"])
            finally:
                other.close()
            return build(*args, **kwargs)
        result = self.library.run_one(self.root, "cpu", builder=cancelling, verifier=verify)
        self.assertEqual(result["status"], "cancelled")
        self.assertIsNone(self.library.active(verify))

    def test_power_loss_after_parse_restarts_without_duplicate_output(self):
        row = self.library.register_pdf("power", self.first)
        def interrupt(stage):
            if stage == "parsed": raise SimulatedPowerLoss()
        with self.assertRaises(SimulatedPowerLoss):
            self.run_job(hook=interrupt)
        self.assertEqual(self.library.job(row["id"])["status"], "parsing")
        self.assertEqual(self.run_job()["status"], "published")
        self.assertIsNone(self.run_job())
        self.assertEqual(self.library.db.execute("SELECT COUNT(*) FROM papers").fetchone()[0], 1)

    def test_power_loss_between_pointer_and_commit_recovers_published_result(self):
        row = self.library.register_pdf("power", self.first)
        def interrupt(stage):
            if stage == "pointer_replaced": raise SimulatedPowerLoss()
        with self.assertRaises(SimulatedPowerLoss):
            self.run_job(hook=interrupt)
        self.assertEqual(self.library.job(row["id"])["status"], "validating")
        self.library.close()
        self.library = Library(self.root / "library")
        active = self.library.recover(verify)
        self.assertEqual(self.library.job(row["id"])["status"], "published")
        self.assertEqual(self.library.job(row["id"])["version"], active["version"])
        self.assertIsNone(self.run_job())

    def test_interrupted_jobs_have_bounded_restarts_and_explicit_retry(self):
        row = self.library.register_pdf("bounded", self.first)
        def interrupt(stage):
            if stage == "parsed": raise SimulatedPowerLoss()
        for _ in range(3):
            with self.assertRaises(SimulatedPowerLoss):
                self.run_job(hook=interrupt)
        self.assertEqual(self.run_job()["error"], "IMPORT_RETRY_LIMIT")
        self.library.retry(row["id"])
        self.assertEqual(self.run_job()["status"], "published")
        self.assertEqual(self.library.job(row["id"])["attempts"], 1)

    def test_index_tampering_and_parallel_heavy_work_fail_closed(self):
        self.library.register_pdf("first", self.first)
        self.run_job()
        active = self.library.active(verify)
        with self.library.exclusive():
            other = Library(self.library.root)
            try:
                with self.assertRaisesRegex(LibraryError, "LIBRARY_BUSY"):
                    with other.exclusive(): pass
            finally:
                other.close()
        self.library.path(active["index"]).joinpath("index-manifest.json").write_bytes(b"{}")
        with self.assertRaisesRegex(LibraryError, "INDEX_MANIFEST_CHANGED"):
            self.library.active(verify)

    def test_reject_relative_paths_metadata_commands_and_changed_objects(self):
        with self.assertRaises(LibraryError):
            self.library.register_pdf("relative", Path("file.pdf"))
        with self.assertRaises(LibraryError):
            self.library.register_pdf("bad", self.first, {"command": "anything"})
        self.library.register_pdf("known", self.first)
        next((self.root / "library/objects").glob("*.pdf")).write_bytes(b"%PDF-forged")
        self.assertEqual(self.run_job()["error"], "LIBRARY_OBJECT_CHANGED")

if __name__ == "__main__":
    unittest.main()
