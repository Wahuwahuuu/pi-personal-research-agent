"""Recover malformed ToUnicode entries only from the same embedded font.

The CMap adapter is deliberately bound to pypdf 7.0.1. No font-name guesses,
system-font substitution, OCR or model-generated characters are used.
"""
from contextlib import ExitStack
from hashlib import sha256
from io import BytesIO
import re


class PdfEncodingError(ValueError):
    def __init__(self):
        super().__init__("PDF_TEXT_ENCODING_INVALID")


def scalar_text(value):
    return value.encode("utf-16-be", "surrogatepass").decode("utf-16-be")


def _font_name(value):
    return re.sub(r"^[A-Z]{6}\+", "", str(value).lstrip("/"))


def _glyph_candidates(font):
    candidates = {}
    for table in font["cmap"].tables:
        if table.isUnicode():
            for code, glyph in table.cmap.items():
                if 0 < code <= 0x10ffff and not 0xd800 <= code <= 0xdfff and code != 0xfffd:
                    candidates.setdefault(glyph, set()).add(code)
    # ssty changes math script-size glyph forms, not the underlying character.
    # Other GSUB features may change meaning and are intentionally not reversed.
    if "GSUB" in font:
        gsub = font["GSUB"].table
        lookups = {index for record in gsub.FeatureList.FeatureRecord if record.FeatureTag == "ssty"
                   for index in record.Feature.LookupListIndex}
        direct = {key: set(value) for key, value in candidates.items()}
        for index in lookups:
            lookup = gsub.LookupList.Lookup[index]
            for sub in lookup.SubTable:
                kind = lookup.LookupType
                if kind == 7:
                    kind, sub = sub.ExtensionLookupType, sub.ExtSubTable
                mapping = getattr(sub, "mapping", {}) if kind == 1 else getattr(sub, "alternates", {}) if kind == 3 else {}
                for source, targets in mapping.items():
                    for target in targets if isinstance(targets, list) else [targets]:
                        candidates.setdefault(target, set()).update(direct.get(source, ()))
    return candidates


def _embedded_map(font, codes):
    from fontTools.ttLib import TTFont, TTCollection
    if font.get("/Subtype") != "/Type0" or font.get("/Encoding") != "/Identity-H":
        raise PdfEncodingError()
    descendants = font["/DescendantFonts"]
    if len(descendants) != 1:
        raise PdfEncodingError()
    descendant = descendants[0].get_object()
    if descendant.get("/Subtype") != "/CIDFontType2":
        raise PdfEncodingError()
    data = descendant["/FontDescriptor"]["/FontFile2"].get_data()
    if not 0 < len(data) <= 16 * 1024 * 1024:
        raise PdfEncodingError()
    name = _font_name(font["/BaseFont"])
    with ExitStack() as stack:
        if data.startswith(b"ttcf"):
            if int.from_bytes(data[8:12], "big") not in range(1, 17):
                raise PdfEncodingError()
            collection = TTCollection(BytesIO(data), lazy=True)
            stack.callback(collection.close)
            matches = [f for f in collection.fonts if _font_name(f["name"].getDebugName(6)) == name]
            if len(matches) != 1:
                raise PdfEncodingError()
            embedded = matches[0]
        else:
            embedded = stack.enter_context(TTFont(BytesIO(data), lazy=True))
            if _font_name(embedded["name"].getDebugName(6)) != name:
                raise PdfEncodingError()
        candidates = _glyph_candidates(embedded)
        glyphs = embedded.getGlyphOrder()
        cid_map = descendant.get("/CIDToGIDMap")
        if cid_map != "/Identity":
            if cid_map is None:
                raise PdfEncodingError()
            cid_map = cid_map.get_object().get_data()
            if len(cid_map) % 2 or len(cid_map) > 131072:
                raise PdfEncodingError()
        result = {}
        for code in codes:
            if not 0 <= code <= 65535:
                raise PdfEncodingError()
            if isinstance(cid_map, bytes):
                if len(cid_map) < 2 * code + 2:
                    raise PdfEncodingError()
                gid = int.from_bytes(cid_map[2 * code:2 * code + 2], "big")
            else:
                gid = code
            if not 0 < gid < len(glyphs):
                raise PdfEncodingError()
            possible = candidates.get(glyphs[gid], set())
            if len(possible) != 1:
                raise PdfEncodingError()
            result[code] = chr(next(iter(possible)))
        return result, sha256(data).hexdigest()


def _repair_font(font):
    import pypdf
    from pypdf._cmap import _parse_to_unicode
    from pypdf.generic import DecodedStreamObject, NameObject
    if "/ToUnicode" not in font:
        return None
    unicode_map = font["/ToUnicode"]
    if not hasattr(unicode_map, "get_data"):
        return None
    raw = unicode_map.get_data()
    if len(raw) > 2 * 1024 * 1024:
        raise PdfEncodingError()
    mapping, _ = _parse_to_unicode(font)
    broken = {}
    for key, value in mapping.items():
        try:
            scalar_text(value)
        except UnicodeError:
            if not isinstance(key, str) or len(key) != 1 or len(value) != 1:
                raise PdfEncodingError()
            broken[ord(key)] = value
    if not broken:
        return None
    if pypdf.__version__ != "7.0.1" or b"usecmap" in raw.lower():
        raise PdfEncodingError()
    replacements, font_hash = _embedded_map(font, broken)
    counts = {key: 0 for key in broken}
    # Change explicit two-byte bfchar entries only. Never rewrite normal entries
    # or expand an unfamiliar range/map based on an incomplete parser result.
    def block(match):
        def pair(item):
            code = int(item[1], 16)
            if code not in broken:
                return item[0]
            if bytes.fromhex(item[2].decode()) != broken[code].encode("utf-16-be", "surrogatepass"):
                raise PdfEncodingError()
            counts[code] += 1
            return b"<" + item[1] + b"> <" + replacements[code].encode("utf-16-be").hex().encode() + b">"
        return re.sub(rb"<([0-9a-fA-F]{4})>\s*<([0-9a-fA-F]{4})>", pair, match[0])
    updated = re.sub(rb"beginbfchar\b.*?\bendbfchar", block, raw, flags=re.DOTALL)
    if any(count != 1 for count in counts.values()):
        raise PdfEncodingError()
    stream = DecodedStreamObject()
    stream.set_data(updated)
    original = font["/ToUnicode"]
    font[NameObject("/ToUnicode")] = stream
    expected = {**mapping, **{chr(key): value for key, value in replacements.items()}}
    try:
        actual, _ = _parse_to_unicode(font)
        if actual != expected:
            raise PdfEncodingError()
    except Exception:
        font[NameObject("/ToUnicode")] = original
        raise
    return {"entries": len(broken), "fontSha256": font_hash,
            "originalMapSha256": sha256(raw).hexdigest(), "repairedMapSha256": sha256(updated).hexdigest()}


class EmbeddedUnicodeRepair:
    def __init__(self):
        self.fonts, self.resources, self.repairs = set(), set(), []

    def prepare(self, resources, depth=0):
        if resources is None:
            return
        resources = resources.get_object()
        if id(resources) in self.resources:
            return
        if depth > 32 or len(self.resources) >= 1024:
            raise PdfEncodingError()
        self.resources.add(id(resources))
        try:
            for reference in (resources["/Font"].get_object() if "/Font" in resources else {}).values():
                font = reference.get_object()
                if id(font) in self.fonts:
                    continue
                if len(self.fonts) >= 1024:
                    raise PdfEncodingError()
                self.fonts.add(id(font))
                repair = _repair_font(font)
                if repair:
                    self.repairs.append(repair)
            for reference in (resources["/XObject"].get_object() if "/XObject" in resources else {}).values():
                form = reference.get_object()
                if form.get("/Subtype") == "/Form":
                    self.prepare(form.get("/Resources"), depth + 1)
        except PdfEncodingError:
            raise
        except Exception:
            raise PdfEncodingError() from None
