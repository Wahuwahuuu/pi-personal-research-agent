import hashlib
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.ttLib import TTCollection
from pypdf import PdfWriter, PdfReader
from pypdf.generic import DictionaryObject, NameObject, ArrayObject, DecodedStreamObject
from retriever.library import extract_pdf, LibraryError


def font_bytes(name="TestMath", ambiguous=False, scripts=True):
    builder = FontBuilder(1000, isTTF=True)
    glyphs = [".notdef", "E", "F", "E.script", "normal"]
    builder.setupGlyphOrder(glyphs)
    builder.setupCharacterMap({0x1d438: "E", 0x1d439: "F", 0x5a: "normal",
                               **({0x45: "E"} if ambiguous else {})})
    builder.setupGlyf({g: TTGlyphPen(None).glyph() for g in glyphs})
    builder.setupHorizontalMetrics({g: (600, 0) for g in glyphs})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": name, "styleName": "Regular", "psName": name,
                           "fullName": name, "uniqueFontIdentifier": name})
    builder.setupOS2()
    builder.setupPost()
    builder.setupMaxp()
    if scripts:
        addOpenTypeFeaturesFromString(builder.font, "feature ssty { sub E from [E.script]; } ssty;")
    return builder.font


def make_pdf(path, *, pairs=None, content="0001000200030004", collection=False,
             ambiguous=False, scripts=True, cid_map=None, encoding="/Identity-H",
             embedded=True, collection_name="TestMath", nested=False, ranges=False):
    writer = PdfWriter()
    page = writer.add_blank_page(600, 800)
    data = BytesIO()
    first = font_bytes(ambiguous=ambiguous, scripts=scripts)
    if collection:
        fonts = TTCollection()
        fonts.fonts = [font_bytes("OtherMath"), first]
        fonts.save(data)
    else:
        first.save(data)
    def stream(value):
        result = DecodedStreamObject()
        result.set_data(value)
        return writer._add_object(result)
    descriptor = DictionaryObject({NameObject("/Type"): NameObject("/FontDescriptor")})
    if embedded:
        descriptor[NameObject("/FontFile2")] = stream(data.getvalue())
    descendant = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/CIDFontType2"),
        NameObject("/FontDescriptor"): writer._add_object(descriptor),
        NameObject("/CIDToGIDMap"): stream(cid_map) if cid_map is not None else NameObject("/Identity")})
    pairs = pairs if pairs is not None else [(1, "D835"), (2, "DC39"), (3, "D835"), (4, "0037")]
    mapping = ("begincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
               + (f"{len(pairs)} beginbfrange\n" + "\n".join(f"<{n:04X}> <{n:04X}> <{v}>" for n, v in pairs) + "\nendbfrange\n" if ranges
                  else f"{len(pairs)} beginbfchar\n" + "\n".join(f"<{n:04X}> <{v}>" for n, v in pairs) + "\nendbfchar\n")
               + "endcmap").encode()
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type0"), NameObject("/BaseFont"): NameObject("/ABCDEF+" + collection_name),
        NameObject("/Encoding"): NameObject(encoding),
        NameObject("/DescendantFonts"): ArrayObject([writer._add_object(descendant)]),
        NameObject("/ToUnicode"): stream(mapping)})
    resources = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    text = ("BT /F1 12 Tf 50 700 Td <" + content + "> Tj ET").encode()
    if nested:
        form = DecodedStreamObject()
        form.set_data(text)
        form[NameObject("/Subtype")] = NameObject("/Form")
        form[NameObject("/Resources")] = resources
        form[NameObject("/BBox")] = ArrayObject()
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/XObject"): DictionaryObject({NameObject("/X"): writer._add_object(form)})})
        page[NameObject("/Contents")] = stream(b"/X Do")
    else:
        page[NameObject("/Resources")] = resources
        page[NameObject("/Contents")] = stream(text)
    with path.open("wb") as output:
        writer.write(output)


class EmbeddedUnicodeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="pra-unicode-")
        self.path = Path(self.directory.name) / "paper.pdf"

    def tearDown(self):
        self.directory.cleanup()

    def extract(self):
        return extract_pdf(self.path, "paper", {"title": "Paper", "authors": "", "abstract": ""})

    def test_embedded_font_recovers_each_glyph_before_adjacent_halves_can_merge(self):
        make_pdf(self.path, collection=True, nested=True)
        before = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.assertIn("\ud835\udc39", PdfReader(self.path).pages[0].extract_text())
        result = self.extract()
        self.assertEqual(result["paper"]["full_text"][0]["paragraphs"][0].strip(), "\U0001d438\U0001d439\U0001d4387")
        self.assertEqual(result["metadata"]["unicodeRepairs"][0]["entries"], 3)
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), before)

    def test_explicit_cid_to_glyph_map_uses_font_glyph_identity(self):
        gids = bytearray(42)
        gids[20:22], gids[40:42] = b"\0\1", b"\0\2"
        make_pdf(self.path, pairs=[(10, "D835"), (20, "DC39")], content="000A0014", cid_map=bytes(gids))
        self.assertEqual(self.extract()["paper"]["full_text"][0]["paragraphs"][0], "\U0001d438\U0001d439")

    def test_ambiguous_missing_or_non_script_glyphs_are_not_guessed(self):
        for options in [{"ambiguous": True}, {"embedded": False}, {"scripts": False},
                        {"encoding": "/Identity-V"}, {"collection": True, "collection_name": "UnknownFont"},
                        {"cid_map": b"\0"}, {"ranges": True}]:
            with self.subTest(options=options):
                make_pdf(self.path, **options)
                with self.assertRaisesRegex(LibraryError, "PDF_TEXT_ENCODING_INVALID"):
                    self.extract()

    def test_valid_map_remains_identical_and_needs_no_embedded_font(self):
        make_pdf(self.path, pairs=[(1, "D835DC38"), (2, "D835DC39"), (4, "0037")],
                 content="000100020004", embedded=False)
        before = PdfReader(self.path).pages[0].extract_text()
        result = self.extract()
        self.assertEqual(result["paper"]["full_text"][0]["paragraphs"][0], before)
        self.assertNotIn("unicodeRepairs", result["metadata"])

    def test_valid_mapping_is_not_replaced_by_font_cmap(self):
        make_pdf(self.path, pairs=[(1, "D835"), (4, "0037")], content="00010004")
        # Glyph 4's embedded cmap is Z, but its valid PDF mapping is 7.
        self.assertEqual(self.extract()["paper"]["full_text"][0]["paragraphs"][0], "\U0001d4387")


if __name__ == "__main__":
    unittest.main()
