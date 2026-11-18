"""EvoScholar literature toolkit — deterministic helpers the agent can import inside run_python.

    import evoscholar_lit as lit
    lit.normalize_doi("https://doi.org/10.1000/ABC.")    -> "10.1000/abc"
    lit.merge_records(records)                          -> groups of matching records
    lit.pdf_pages("paper.pdf")                          -> [{"page": 1, "text": ...}, ...]
    lit.pdf_find("paper.pdf", r"n\\s*=\\s*\\d+")          -> page-numbered hits
    lit.parse_any(text)                                 -> records from RIS / BibTeX / EndNote / NoteExpress / GB/T 7714

Only the standard library is required; PDF functions use PyMuPDF (fitz) when installed.
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from typing import Any, Iterable

DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"<>{}]+", re.I)
ARXIV_NEW = re.compile(r"(?<![\d.])(\d{4}\.\d{4,5})(v\d+)?", re.I)
ARXIV_OLD = re.compile(r"([a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?", re.I)


def normalize_doi(value: Any) -> str | None:
    """Lower-case bare DOI without resolver prefix or trailing punctuation; None if absent."""
    if not value:
        return None
    s = unicodedata.normalize("NFKC", str(value)).strip()
    s = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:\s*)", "", s, flags=re.I)
    m = DOI_RE.search(s)
    if not m:
        return None
    return m.group(0).rstrip(".,;:)]}'\"").lower()


def normalize_arxiv(value: Any, keep_version: bool = False) -> str | None:
    if not value:
        return None
    s = str(value).strip()
    s = re.sub(r"^(arxiv:|https?://arxiv\.org/(abs|pdf)/)", "", s, flags=re.I)
    s = re.sub(r"\.pdf$", "", s, flags=re.I)
    for pat in (ARXIV_NEW, ARXIV_OLD):
        m = pat.search(s)
        if m:
            return (m.group(1) + (m.group(2) or "" if keep_version else "")).lower()
    return None


def title_key(title: Any) -> str:
    """Case/width/punctuation-insensitive key for comparing titles (CJK kept)."""
    s = unicodedata.normalize("NFKC", str(title or "")).lower()
    return re.sub(r"[^0-9a-z一-鿿]+", "", s)


def surname(author: Any) -> str:
    a = str(author or "").strip()
    if not a:
        return ""
    if "," in a:
        return title_key(a.split(",")[0])
    if re.search(r"[一-鿿]", a):
        return title_key(a[:1])
    return title_key(a.split()[-1])


def _get(rec: dict, *names: str) -> Any:
    for n in names:
        if rec.get(n) not in (None, "", []):
            return rec[n]
    return None


def first_author(rec: dict) -> str:
    a = _get(rec, "authors", "author", "creators", "first_author")
    if isinstance(a, list):
        a = a[0] if a else ""
        if isinstance(a, dict):
            a = a.get("family") or a.get("lastName") or a.get("name") or ""
    elif isinstance(a, str) and ";" in a:
        a = a.split(";")[0]
    elif isinstance(a, str) and " and " in a:
        a = a.split(" and ")[0]
    return str(a or "")


def record_keys(rec: dict) -> dict:
    links = []
    for f in ("published_doi", "journal_doi", "version_of", "related_doi", "is_version_of", "published_as"):
        d = normalize_doi(rec.get(f))
        if d:
            links.append(d)
    year = _get(rec, "year", "issued", "date", "published")
    m = re.search(r"(19|20)\d{2}", str(year or ""))
    return {
        "doi": normalize_doi(_get(rec, "doi", "DOI")),
        "arxiv": normalize_arxiv(_get(rec, "arxiv", "arxiv_id", "eprint", "arXiv")),
        "links": links,
        "title": title_key(_get(rec, "title", "TI")),
        "author": surname(first_author(rec)),
        "year": int(m.group(0)) if m else None,
    }


def merge_records(records: Iterable[dict], id_field: str = "id", fuzzy: bool = True) -> list[dict]:
    """Group records describing the same work.

    Linked by: identical normalized DOI, identical arXiv id (version ignored), an explicit
    published-version DOI field, or (fuzzy) identical title key + first-author surname with
    years within 1. Returns [{"records": [ids], "doi": str|None, "arxiv": str|None, "members": [...]}].
    """
    recs = list(records)
    parent = list(range(len(recs)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    keys = [record_keys(r) for r in recs]
    by: dict[tuple, int] = {}
    for i, k in enumerate(keys):
        for key in [("doi", k["doi"]), ("arxiv", k["arxiv"])] + [("doi", d) for d in k["links"]]:
            if key[1]:
                if key in by:
                    union(by[key], i)
                else:
                    by[key] = i
    if fuzzy:
        for i in range(len(recs)):
            for j in range(i + 1, len(recs)):
                a, b = keys[i], keys[j]
                if a["title"] and a["title"] == b["title"] and (not a["author"] or not b["author"] or a["author"] == b["author"]):
                    if a["year"] is None or b["year"] is None or abs(a["year"] - b["year"]) <= 1:
                        union(i, j)
    groups: dict[int, list[int]] = {}
    for i in range(len(recs)):
        groups.setdefault(find(i), []).append(i)
    out = []
    for members in groups.values():
        dois = [keys[i]["doi"] for i in members if keys[i]["doi"]]
        # Prefer a journal/conference DOI over an arXiv DataCite DOI.
        dois.sort(key=lambda d: d.startswith("10.48550/"))
        arx = next((keys[i]["arxiv"] for i in members if keys[i]["arxiv"]), None)
        out.append({
            "records": [str(recs[i].get(id_field, i)) for i in members],
            "doi": dois[0] if dois else None,
            "arxiv": arx,
            "members": [recs[i] for i in members],
        })
    return out


# ---------------- PDF ----------------

def _fitz():
    try:
        import pymupdf as fitz  # PyMuPDF ≥ 1.24; `import fitz` prints a deprecation warning
        return fitz
    except ImportError:
        pass
    try:
        import fitz  # older PyMuPDF
        return fitz
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("需要 PyMuPDF：npm run setup:python") from e


def pdf_pages(path: str, pages: Iterable[int] | None = None) -> list[dict]:
    """Per-page text (1-based page numbers). `has_text` False means scanned → render and read as image."""
    fitz = _fitz()
    doc = fitz.open(path)
    want = set(pages) if pages else None
    out = []
    for i, page in enumerate(doc, start=1):
        if want and i not in want:
            continue
        text = page.get_text("text")
        out.append({"page": i, "text": text, "has_text": len(text.strip()) > 20})
    return out


def pdf_find(path: str, pattern: str, regex: bool = True, context: int = 80, flags: int = re.I) -> list[dict]:
    hits = []
    pat = re.compile(pattern if regex else re.escape(pattern), flags)
    for p in pdf_pages(path):
        flat = re.sub(r"\s+", " ", p["text"])
        for m in pat.finditer(flat):
            hits.append({"page": p["page"], "match": m.group(0), "context": flat[max(0, m.start() - context): m.end() + context]})
    return hits


def pdf_render(path: str, page: int, out: str, dpi: int = 150) -> str:
    fitz = _fitz()
    doc = fitz.open(path)
    pix = doc[page - 1].get_pixmap(dpi=dpi)
    pix.save(out)
    return out


# ---------------- importers ----------------

def parse_ris(text: str) -> list[dict]:
    recs, cur = [], {}
    for line in text.splitlines():
        m = re.match(r"^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$", line)
        if not m:
            continue
        tag, val = m.group(1), m.group(2).strip()
        if tag == "TY":
            cur = {"type": val, "authors": []}
        elif tag == "ER":
            if cur:
                recs.append(cur)
            cur = {}
        elif tag in ("AU", "A1", "A2"):
            cur.setdefault("authors", []).append(val)
        elif tag in ("TI", "T1"):
            cur["title"] = val
        elif tag in ("JO", "JF", "T2", "J2") and "venue" not in cur:
            cur["venue"] = val
        elif tag in ("PY", "Y1", "DA") and "year" not in cur:
            y = re.search(r"\d{4}", val)
            if y:
                cur["year"] = int(y.group(0))
        elif tag == "DO":
            cur["doi"] = normalize_doi(val)
        elif tag == "VL":
            cur["volume"] = val
        elif tag == "IS":
            cur["issue"] = val
        elif tag == "SP":
            cur["pages"] = val
        elif tag == "EP":
            cur["pages"] = f"{cur.get('pages', '')}-{val}"
        elif tag == "AB":
            cur["abstract"] = val
        elif tag == "KW":
            cur.setdefault("keywords", []).append(val)
        elif tag == "UR":
            cur.setdefault("url", val)
    return recs


def parse_bibtex(text: str) -> list[dict]:
    recs = []
    for m in re.finditer(r"@(\w+)\s*\{\s*([^,\s]+)\s*,(.*?)\n\}", text, re.S):
        body = m.group(3)
        rec = {"type": m.group(1).lower(), "key": m.group(2)}
        for f in re.finditer(r"(\w+)\s*=\s*(\{((?:[^{}]|\{[^{}]*\})*)\}|\"([^\"]*)\"|(\d+))", body):
            name = f.group(1).lower()
            val = f.group(3) if f.group(3) is not None else (f.group(4) if f.group(4) is not None else f.group(5))
            val = re.sub(r"[{}]", "", val or "").strip()
            rec[name] = val
        if "author" in rec:
            rec["authors"] = [a.strip() for a in rec.pop("author").split(" and ")]
        if "doi" in rec:
            rec["doi"] = normalize_doi(rec["doi"])
        if "year" in rec and re.search(r"\d{4}", rec["year"]):
            rec["year"] = int(re.search(r"\d{4}", rec["year"]).group(0))
        rec["venue"] = rec.get("journal") or rec.get("booktitle")
        recs.append(rec)
    return recs


def parse_endnote(text: str) -> list[dict]:
    """EndNote / CNKI '%'-tagged export."""
    recs, cur = [], {}
    for line in text.splitlines() + [""]:
        if not line.strip():
            if cur:
                recs.append(cur)
            cur = {}
            continue
        m = re.match(r"^%(\S)\s+(.*)$", line)
        if not m:
            continue
        t, v = m.group(1), m.group(2).strip()
        if t == "0":
            cur["type"] = v
        elif t == "A":
            cur.setdefault("authors", []).extend([x.strip() for x in re.split(r"[;；]", v) if x.strip()])
        elif t == "T":
            cur["title"] = v
        elif t in ("J", "B"):
            cur["venue"] = v
        elif t == "D":
            y = re.search(r"\d{4}", v)
            if y:
                cur["year"] = int(y.group(0))
        elif t == "V":
            cur["volume"] = v
        elif t == "N":
            cur["issue"] = v
        elif t == "P":
            cur["pages"] = v
        elif t == "R":
            cur["doi"] = normalize_doi(v)
        elif t == "X":
            cur["abstract"] = v
        elif t == "K":
            cur["keywords"] = [x for x in re.split(r"[;；,，]", v) if x.strip()]
        elif t == "U":
            cur["url"] = v
    return recs


def parse_noteexpress(text: str) -> list[dict]:
    """NoteExpress export ('{Reference Type}: Journal Article' blocks), as produced by CNKI/Wanfang."""
    recs, cur = [], {}
    fields = {"Title": "title", "Journal": "venue", "Year": "year", "Volume": "volume", "Issue": "issue",
              "Pages": "pages", "DOI": "doi", "Abstract": "abstract", "URL": "url", "Keywords": "keywords"}
    for line in text.splitlines():
        m = re.match(r"^\{([^}]+)\}:\s*(.*)$", line.strip())
        if not m:
            continue
        k, v = m.group(1).strip(), m.group(2).strip()
        if k == "Reference Type":
            if cur:
                recs.append(cur)
            cur = {"type": v}
        elif k == "Author":
            cur.setdefault("authors", []).extend([x for x in re.split(r"[;；]", v) if x.strip()])
        elif k in fields:
            if k == "Year":
                y = re.search(r"\d{4}", v)
                cur["year"] = int(y.group(0)) if y else v
            elif k == "DOI":
                cur["doi"] = normalize_doi(v)
            elif k == "Keywords":
                cur["keywords"] = [x for x in re.split(r"[;；,，]", v) if x.strip()]
            else:
                cur[fields[k]] = v
    if cur:
        recs.append(cur)
    return recs


GBT_TYPES = {"J": "journal", "M": "book", "C": "conference", "D": "thesis", "P": "patent", "R": "report", "N": "newspaper", "S": "standard", "EB/OL": "web", "A": "chapter"}


def parse_gbt7714(text: str) -> list[dict]:
    """Heuristic parser for GB/T 7714 reference lines, e.g. '[1] 张三, 李四. 题名[J]. 刊名, 2024, 44(3): 1-10.'"""
    recs = []
    for raw in re.split(r"\n(?=\s*\[\d+\])|\n{2,}", text):
        line = re.sub(r"\s+", " ", raw).strip()
        if not line:
            continue
        line = re.sub(r"^\[\d+\]\s*", "", line)
        m = re.match(r"^(?P<authors>.+?)\.\s*(?P<title>.+?)\[(?P<type>[A-Z/]+)\]\.?\s*(?P<rest>.*)$", line)
        if not m:
            recs.append({"raw": line, "parse_error": True})
            continue
        rec = {"authors": [a.strip() for a in re.split(r"[,，]", m.group("authors")) if a.strip() and a.strip() not in ("等", "et al")],
               "title": m.group("title").strip(), "type": GBT_TYPES.get(m.group("type"), m.group("type")), "raw": line}
        rest = m.group("rest")
        y = re.search(r"(19|20)\d{2}", rest)
        if y:
            rec["year"] = int(y.group(0))
            rec["venue"] = rest[: y.start()].strip(" ,，.:：")
        vi = re.search(r",\s*(\d+)\s*\((\d+)\)", rest)
        if vi:
            rec["volume"], rec["issue"] = vi.group(1), vi.group(2)
        pg = re.search(r":\s*([\dA-Za-z]+\s*[-–~]\s*[\dA-Za-z]+|\d+)\s*\.?", rest)
        if pg:
            rec["pages"] = pg.group(1).replace(" ", "")
        d = normalize_doi(rest)
        if d:
            rec["doi"] = d
        recs.append(rec)
    return recs


def parse_any(text: str) -> tuple[str, list[dict]]:
    """Detect the export format and parse it. Returns (format, records)."""
    t = text.lstrip("﻿")
    if re.search(r"^TY\s{1,2}-", t, re.M):
        return "ris", parse_ris(t)
    if re.search(r"^@\w+\s*\{", t, re.M):
        return "bibtex", parse_bibtex(t)
    if re.search(r"^\{Reference Type\}:", t, re.M):
        return "noteexpress", parse_noteexpress(t)
    if re.search(r"^%[0AT]\s", t, re.M):
        return "endnote", parse_endnote(t)
    return "gbt7714", parse_gbt7714(t)


def citation_hops(edges: Iterable[tuple[str, str]], seed: str) -> dict:
    """One-hop citation tracking with edges interpreted as citing -> cited. Duplicates merged."""
    e = {(a.strip(), b.strip()) for a, b in edges if a and b and a.strip() != b.strip()}
    return {"forward": sorted({a for a, b in e if b == seed}), "backward": sorted({b for a, b in e if a == seed})}


if __name__ == "__main__":  # used by the host tools: python evoscholar_lit.py <command> <args...>
    cmd, *args = sys.argv[1:]
    if cmd == "pages":
        pages = [int(x) for x in args[1].split(",")] if len(args) > 1 and args[1] else None
        print(json.dumps(pdf_pages(args[0], pages), ensure_ascii=False))
    elif cmd == "render":
        print(pdf_render(args[0], int(args[1]), args[2], int(args[3]) if len(args) > 3 else 150))
    elif cmd == "parse":
        with open(args[0], encoding="utf-8-sig", errors="replace") as f:
            fmt, recs = parse_any(f.read())
        print(json.dumps({"format": fmt, "records": recs}, ensure_ascii=False))
    else:
        raise SystemExit(f"unknown command {cmd}")
