"""EvoScholar manuscript checker: parse LaTeX / Word / Markdown / PDF into one document model,
run checks configured by rule packs (rulepacks/writing/<pack>.yaml), report findings with
locations (file:line, 段落 N, p.N), and optionally write comments back.

    import evoscholar_write as Wr
    doc = Wr.load('inputs/main.tex')                 # or .docx / .md / .pdf
    rep = Wr.run('inputs/main.tex', packs=['hust-thesis'], variant='master')
    print(Wr.format_report(rep))

Every rule in a pack names its source (author guideline URL or template file + check date).
Rules the packs could not verify are not checked; they are listed under `verify` so the user
can confirm them against the venue's latest instructions.

CLI (used by the manuscript_check tool):
    python evoscholar_write.py check <file> [--pack P ...] [--variant V] [--out DIR] [--annotate]
    python evoscholar_write.py packs
"""
from __future__ import annotations

import bisect
import json
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

RULES_DIR = Path(__file__).resolve().parent.parent / 'rulepacks' / 'writing'
CJK = r'\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff'
HAS_CJK = re.compile(f'[{CJK}]')

# Chinese font-size names → points (标准字号).
ZH_SIZES = {'初号': 42, '小初': 36, '一号': 26, '小一': 24, '二号': 22, '小二': 18, '三号': 16, '小三': 15,
            '四号': 14, '小四': 12, '五号': 10.5, '小五': 9, '六号': 7.5, '小六': 6.5, '七号': 5.5, '八号': 5}


def pt(size: Any) -> float | None:
    if size is None:
        return None
    if isinstance(size, (int, float)):
        return float(size)
    s = str(size).strip()
    if s in ZH_SIZES:
        return float(ZH_SIZES[s])
    m = re.fullmatch(r'([\d.]+)\s*pt', s)
    return float(m.group(1)) if m else None


# ============================================================ document model

@dataclass
class Doc:
    path: Path
    kind: str                                   # latex | docx | markdown | text | pdf
    root: Path
    text: str = ''                              # body text (LaTeX: comment-stripped, inputs inlined)
    offsets: list = field(default_factory=list)  # [(offset, file, line)] for loc lookup
    paragraphs: list = field(default_factory=list)   # docx/markdown units: {i, text, style, level, ...}
    sections: list = field(default_factory=list)     # {level, title, loc, number?}
    labels: list = field(default_factory=list)       # {name, loc}
    refs: list = field(default_factory=list)         # {name, cmd, loc}
    cites: list = field(default_factory=list)        # {keys: [...], loc}  (numeric styles: ints)
    graphics: list = field(default_factory=list)     # {path, loc, exists}
    floats: list = field(default_factory=list)       # {kind, number, caption, label, loc}
    equations: list = field(default_factory=list)    # {label?, number?, loc}
    bib: list = field(default_factory=list)          # parsed .bib records or {raw, n, loc}
    bib_files: list = field(default_factory=list)
    bibstyle: str | None = None
    meta: dict = field(default_factory=dict)         # title, abstract, abstract_en, keywords, keywords_en, authors, ack
    files: list = field(default_factory=list)        # files actually reached (LaTeX)
    unreached: list = field(default_factory=list)    # .tex files next to main that are not part of the build
    pdf: dict = field(default_factory=dict)          # page map / metadata for PDFs
    notes: list = field(default_factory=list)

    def loc(self, offset: int) -> str:
        if not self.offsets:
            return ''
        i = bisect.bisect_right([o for o, _, _ in self.offsets], offset) - 1
        o, f, line = self.offsets[max(i, 0)]
        if f == '段落':
            return f'段落 {line}'
        if f == 'p.':
            return f'p.{line}'
        return f'{f}:{line}'


def finding(rule: str, severity: str, loc: str, message: str, evidence: str = '', source: str = '') -> dict:
    return {'rule': rule, 'severity': severity, 'loc': loc, 'message': message, 'evidence': evidence[:200], 'source': source}


# ============================================================ loaders

def load(path: str | Path) -> Doc:
    p = Path(path)
    ext = p.suffix.lower()
    if ext == '.tex':
        return load_latex(p)
    if ext == '.docx':
        return load_docx(p)
    if ext == '.pdf':
        return load_pdf(p)
    if ext in ('.md', '.markdown', '.txt'):
        return load_markdown(p)
    raise ValueError(f'不支持的稿件格式：{ext}（支持 .tex / .docx / .md / .txt / .pdf）')


# ------------------------------------------------------------ LaTeX

_COMMENT = re.compile(r'(?<!\\)%.*$')
_INPUT = re.compile(r'\\(input|include|subfile)\s*\{([^}]+)\}|\\(?:sub)?import\s*\{([^}]*)\}\s*\{([^}]+)\}')


def _balanced(text: str, start: int) -> tuple[str, int] | None:
    """Content of the {...} group starting at text[start] == '{'."""
    if start >= len(text) or text[start] != '{':
        return None
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == '\\':
            continue
        if c == '{' and (i == 0 or text[i - 1] != '\\'):
            depth += 1
        elif c == '}' and text[i - 1] != '\\':
            depth -= 1
            if depth == 0:
                return text[start + 1:i], i + 1
    return None


def _arg_after(text: str, pos: int) -> tuple[str, int] | None:
    """Skip optional [..] arguments and spaces, then read a balanced {..} argument."""
    i = pos
    while i < len(text):
        if text[i] in ' \t\n*':
            i += 1
        elif text[i] == '[':
            j = text.find(']', i)
            if j < 0:
                return None
            i = j + 1
        else:
            break
    return _balanced(text, i)


def _strip_tex(s: str) -> str:
    s = re.sub(r'\\(textbf|textit|emph|mathrm|text|mbox|textsc|underline)\{([^{}]*)\}', r'\2', s)
    s = re.sub(r'\\[a-zA-Z]+\*?(\[[^\]]*\])?', ' ', s)
    s = s.replace('{', '').replace('}', '').replace('~', ' ')
    return re.sub(r'\s+', ' ', s).strip()


def _contained_path(root: Path, path: Path) -> Path | None:
    try:
        candidate = path.resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    return candidate if candidate.is_relative_to(root) else None


def _output_path(root: Path, path: Path) -> Path:
    target = _contained_path(root, path)
    if target is None:
        raise ValueError('报告路径必须在输出目录内')
    return target


def load_latex(main: Path) -> Doc:
    main = main.resolve()
    root = main.parent
    doc = Doc(path=main, kind='latex', root=root)
    parts: list[str] = []
    offsets: list = []
    pos = 0
    seen: set[Path] = set()

    def resolve(name: str, base: Path) -> Path | None:
        cand = (base / name)
        for c in (cand, cand.with_suffix(cand.suffix + '.tex') if cand.suffix != '.tex' else cand):
            path = _contained_path(root, c)
            if path is not None and path.is_file():
                return path
        return None

    def walk(f: Path):
        nonlocal pos
        if f in seen:
            doc.notes.append(f'循环 \\input：{f.relative_to(root) if f.is_relative_to(root) else f}')
            return
        seen.add(f)
        rel = f.relative_to(root).as_posix() if f.is_relative_to(root) else str(f)
        doc.files.append(rel)
        try:
            lines = f.read_text(encoding='utf-8', errors='replace').splitlines()
        except OSError as e:
            doc.notes.append(f'无法读取 {rel}：{e}')
            return
        for n, raw in enumerate(lines, 1):
            line = _COMMENT.sub('', raw)
            m = _INPUT.search(line)
            if m:
                before = line[:m.start()]
                offsets.append((pos, rel, n)); parts.append(before); pos += len(before)
                name = m.group(2) if m.group(1) else (m.group(3) or '') + m.group(4)
                target = resolve(name.strip(), root)
                if target is None:
                    doc.notes.append(f'{rel}:{n} 找不到 \\{m.group(1) or "import"}{{{name}}}')
                else:
                    walk(target)
                after = line[m.end():] + '\n'
                offsets.append((pos, rel, n)); parts.append(after); pos += len(after)
            else:
                offsets.append((pos, rel, n)); parts.append(line + '\n'); pos += len(line) + 1
    walk(main)
    doc.text = ''.join(parts)
    doc.offsets = offsets
    t = doc.text
    doc.unreached = sorted(str(p.relative_to(root)) for p in root.rglob('*.tex')
                           if (target := _contained_path(root, p)) is not None and target not in seen)

    # graphics path
    gpaths = [root]
    for m in re.finditer(r'\\graphicspath\s*\{', t):
        arg = _balanced(t, m.end() - 1)
        if arg:
            gpaths += [root / g for g in re.findall(r'\{([^}]*)\}', arg[0])]

    for m in re.finditer(r'\\label\s*\{([^}]+)\}', t):
        doc.labels.append({'name': m.group(1).strip(), 'loc': doc.loc(m.start()), 'offset': m.start()})
    for m in re.finditer(r'\\(ref|eqref|cref|Cref|autoref|pageref|nameref|vref|subref)\*?\s*\{([^}]+)\}', t):
        if '#' in m.group(2):   # macro parameter inside \newcommand
            continue
        for name in m.group(2).split(','):
            doc.refs.append({'name': name.strip(), 'cmd': m.group(1), 'loc': doc.loc(m.start()), 'offset': m.start()})
    for m in re.finditer(r'\\(cite[a-zA-Z]*|[pP]arencite|[tT]extcite|[aA]utocite|footcite|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}', t):
        doc.cites.append({'keys': [k.strip() for k in m.group(2).split(',') if k.strip()], 'cmd': m.group(1), 'loc': doc.loc(m.start()), 'offset': m.start()})
    for m in re.finditer(r'\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}', t):
        name = m.group(1).strip()
        exists = False
        for base in gpaths:
            for ext in ('', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.PDF', '.PNG', '.JPG'):
                if (base / (name + ext)).is_file():
                    exists = True
                    break
            if exists:
                break
        doc.graphics.append({'path': name, 'loc': doc.loc(m.start()), 'exists': exists})

    levels = {'part': -1, 'chapter': 0, 'section': 1, 'subsection': 2, 'subsubsection': 3, 'paragraph': 4}
    for m in re.finditer(r'\\(part|chapter|section|subsection|subsubsection|paragraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{', t):
        arg = _balanced(t, m.end() - 1)
        if arg:
            doc.sections.append({'level': levels[m.group(1)], 'cmd': m.group(1), 'starred': bool(m.group(2)), 'title': _strip_tex(arg[0]), 'loc': doc.loc(m.start()), 'offset': m.start()})

    for m in re.finditer(r'\\begin\{(figure|table|figure\*|table\*)\}(.*?)\\end\{\1\}', t, re.S):
        body = m.group(2)
        cap = None
        cm = re.search(r'\\caption\s*(?:\[[^\]]*\])?\s*\{', body)
        if cm:
            arg = _balanced(body, cm.end() - 1)
            cap = _strip_tex(arg[0]) if arg else None
        labs = re.findall(r'\\label\s*\{([^}]+)\}', body)
        main_lab = re.search(r'\\caption\s*(?:\[[^\]]*\])?\s*\{(?:[^{}]|\{[^{}]*\})*\}\s*\\label\s*\{([^}]+)\}|\\label\s*\{([^}]+)\}\s*\\caption', body)
        float_label = (main_lab.group(1) or main_lab.group(2)) if main_lab else (labs[-1] if labs else None)
        doc.floats.append({'kind': m.group(1).rstrip('*'), 'caption': cap, 'label': float_label, 'labels': labs, 'loc': doc.loc(m.start()), 'offset': m.start()})
    for m in re.finditer(r'\\begin\{(equation|align|gather|multline|eqnarray)\}(.*?)\\end\{\1\}', t, re.S):
        lab = re.findall(r'\\label\s*\{([^}]+)\}', m.group(2))
        doc.equations.append({'labels': lab, 'loc': doc.loc(m.start())})

    # bibliography
    bs = re.search(r'\\bibliographystyle\s*\{([^}]+)\}', t)
    doc.bibstyle = bs.group(1).strip() if bs else None
    names = []
    for m in re.finditer(r'\\bibliography\s*\{([^}]+)\}', t):
        names += [n.strip() for n in m.group(1).split(',')]
    for m in re.finditer(r'\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}', t):
        names.append(m.group(1).strip())
    try:
        import evoscholar_lit as lit
    except ImportError:  # pragma: no cover
        lit = None
    for n in names:
        f = _contained_path(root, root / (n if n.endswith('.bib') else n + '.bib'))
        if f is not None and f.is_file() and lit:
            doc.bib_files.append(f.relative_to(root).as_posix())
            text = f.read_text(encoding='utf-8', errors='replace')
            for rec in lit.parse_bibtex(text):
                line = text[: text.find('{' + rec['key'])].count('\n') + 1 if ('{' + rec['key']) in text else 0
                rec['loc'] = f'{f.relative_to(root)}:{line}'
                doc.bib.append(rec)
        else:
            candidates = (_contained_path(root, root / name) for name in (n + '.bbl', main.stem + '.bbl'))
            bbl = next((b for b in candidates if b is not None and b.is_file()), None)
            if bbl is not None:
                # arXiv-style sources ship only the compiled bibliography.
                btxt = bbl.read_text(encoding='utf-8', errors='replace')
                doc.bib_files.append(bbl.relative_to(root).as_posix())
                items = list(re.finditer(r'\\bibitem\s*(?:\[(?:[^\[\]]|\[[^\]]*\])*\])?\s*\{([^}]+)\}', btxt))
                for k, bm in enumerate(items):
                    end = items[k + 1].start() if k + 1 < len(items) else btxt.find('\\end{thebibliography}')
                    doc.bib.append({'key': bm.group(1).strip(), 'raw': _strip_tex(btxt[bm.end(): end if end > 0 else bm.end() + 600]),
                                    'loc': f'{bbl.relative_to(root)}:{btxt[: bm.start()].count(chr(10)) + 1}', 'from_bbl': True})
                doc.notes.append(f'没有 {n}.bib，参考文献取自编译生成的 {bbl.name}')
            else:
                doc.notes.append(f'找不到参考文献库 {n}.bib')
    cited = {k for c in doc.cites for k in c['keys']}
    nocite_all = any(c['cmd'] == 'nocite' and '*' in c['keys'] for c in doc.cites)
    for b in doc.bib:
        if not b.get('from_bbl') and 'raw' not in b:
            b['cited'] = nocite_all or b.get('key') in cited
    for m in re.finditer(r'\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}', t):
        end = t.find('\\bibitem', m.end())
        end = t.find('\\end{thebibliography}', m.end()) if end < 0 else end
        doc.bib.append({'key': m.group(1).strip(), 'raw': _strip_tex(t[m.end(): end if end > 0 else m.end() + 400]), 'loc': doc.loc(m.start())})

    # metadata
    for cmd in ('title', 'author'):
        m = re.search(r'\\' + cmd + r'\s*(?:\[[^\]]*\])?\s*\{', t)
        if m:
            arg = _balanced(t, m.end() - 1)
            if arg:
                doc.meta[cmd] = _strip_tex(arg[0])
                doc.meta[cmd + '_loc'] = doc.loc(m.start())
    m = re.search(r'\\begin\{abstract\}(.*?)\\end\{abstract\}', t, re.S)
    if m:
        doc.meta['abstract'] = _strip_tex(m.group(1))
        doc.meta['abstract_loc'] = doc.loc(m.start())
    m = re.search(r'\\begin\{(IEEEkeywords|keywords)\}(.*?)\\end\{\1\}', t, re.S) or re.search(r'\\keywords\s*\{([^}]*)\}()', t)
    if m:
        kw = m.group(2) if m.lastindex and m.lastindex >= 2 and m.group(2) else m.group(1)
        doc.meta['keywords'] = [k.strip() for k in re.split(r'[,;，；]', _strip_tex(kw)) if k.strip()]
    # Chinese thesis classes (HUSTthesis and similar): \ctitle, \cabstract, \ckeywords, \etitle, \eabstract, \ekeywords
    for cmd, key in (('ctitle', 'title'), ('etitle', 'title_en'), ('cabstract', 'abstract'), ('eabstract', 'abstract_en'),
                     ('ckeywords', 'keywords'), ('ekeywords', 'keywords_en')):
        m = re.search(r'\\' + cmd + r'\s*\{', t)
        if not m:
            continue
        arg = _balanced(t, m.end() - 1)
        if not arg:
            continue
        val = _strip_tex(arg[0])
        if key.startswith('keywords'):
            sep = '；' if '；' in arg[0] else ';' if ';' in arg[0] else '，' if '，' in arg[0] else ','
            doc.meta[key] = [k.strip() for k in re.split(r'[;；,，]', val) if k.strip()]
            doc.meta[key + '_sep'] = sep
        else:
            doc.meta[key] = val
        doc.meta[key + '_loc'] = doc.loc(m.start())
    # Parts generated by the class rather than written as \chapter: add them as top-level sections in order.
    virtual = []
    m = re.search(r'\\makecover|\\maketitle', t)
    if m and doc.meta.get('abstract') and doc.meta.get('abstract_loc', '').startswith(doc.files[0] if doc.files else '') is not None:
        if re.search(r'\\cabstract', t):
            virtual.append((m.start(), '摘要'))
        if re.search(r'\\eabstract', t):
            virtual.append((m.start() + 1, 'Abstract'))
    for pat, title in ((r'\\tableofcontents', '目录'), (r'\\bibliography\s*\{|\\printbibliography', '参考文献'),
                       (r'\\begin\{appendix\}|\\appendix\b', '附录'), (r'\\begin\{(?:ack|acks|acknowledgments?)\}', '致谢')):
        m = re.search(pat, t)
        if m:
            virtual.append((m.start(), title))
    if virtual:
        top = min((s['level'] for s in doc.sections), default=0)
        for off, title in virtual:
            if not any(_norm_title(s['title']) == _norm_title(title) for s in doc.sections):
                doc.sections.append({'level': top, 'cmd': 'virtual', 'starred': True, 'title': title, 'loc': doc.loc(off), 'offset': off, 'virtual': True})
        doc.sections.sort(key=lambda s: s.get('offset', 0))
    m = re.search(r'\\(?:section|chapter)\*?\s*\{\s*(Acknowledg\w*|致\s*谢)\s*\}|\\begin\{(ack|acks|acknowledgments?)\}|\\acks\b', t)
    if m:
        doc.meta['ack_loc'] = doc.loc(m.start())
    m = re.search(r'\\usepackage\s*(\[[^\]]*\])?\s*\{(neurips_\d+|icml\d+|iclr\d+_conference|cvpr|iccv|aaai\d*|ijcai\d*|acl)\}', t)
    if m:
        doc.meta['venue_style'] = m.group(2)
        doc.meta['venue_options'] = (m.group(1) or '').strip('[]')
    return doc


# ------------------------------------------------------------ Word

W_NS = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def _style_chain(style):
    while style is not None:
        yield style
        style = style.base_style


def _run_props(run, para, defaults: dict) -> dict:
    """Effective size (pt), East Asian font and ASCII font of a run (run → paragraph style chain → docDefaults)."""
    size = run.font.size.pt if run.font.size else None
    east = ascii_ = None
    rpr = run._element.rPr
    if rpr is not None and rpr.rFonts is not None:
        east = rpr.rFonts.get(W_NS + 'eastAsia')
        ascii_ = rpr.rFonts.get(W_NS + 'ascii')
    bold = run.font.bold
    for st in _style_chain(para.style):
        if size is None and st.font.size:
            size = st.font.size.pt
        srpr = st.element.rPr
        if srpr is not None and srpr.rFonts is not None:
            east = east or srpr.rFonts.get(W_NS + 'eastAsia')
            ascii_ = ascii_ or srpr.rFonts.get(W_NS + 'ascii')
        if bold is None and st.font.bold is not None:
            bold = st.font.bold
    return {'size': size or defaults.get('size'), 'east': east or defaults.get('east'), 'ascii': ascii_ or defaults.get('ascii'), 'bold': bool(bold)}


def _heading_level(para) -> int | None:
    for st in _style_chain(para.style):
        m = re.match(r'(?:Heading|标题)\s*(\d)', st.name or '')
        if m:
            return int(m.group(1))
        ppr = st.element.pPr
        if ppr is not None:
            ol = ppr.find(W_NS + 'outlineLvl')
            if ol is not None and ol.get(W_NS + 'val') not in (None, '9'):
                return int(ol.get(W_NS + 'val')) + 1
    ppr = para._element.pPr
    if ppr is not None:
        ol = ppr.find(W_NS + 'outlineLvl')
        if ol is not None and ol.get(W_NS + 'val') not in (None, '9'):
            return int(ol.get(W_NS + 'val')) + 1
    return None


def load_docx(path: Path) -> Doc:
    import docx
    d = docx.Document(str(path))
    doc = Doc(path=path.resolve(), kind='docx', root=path.resolve().parent)
    defaults: dict = {}
    dd = d.styles.element.find(f'{W_NS}docDefaults')
    if dd is not None:
        rf = dd.find(f'.//{W_NS}rFonts')
        sz = dd.find(f'.//{W_NS}sz')
        if rf is not None:
            defaults['east'] = rf.get(W_NS + 'eastAsia')
            defaults['ascii'] = rf.get(W_NS + 'ascii')
        if sz is not None:
            defaults['size'] = int(sz.get(W_NS + 'val')) / 2
    body = d.element.body
    i = 0
    texts = []
    pos = 0
    # Walk body in order so we know where tables and images sit relative to captions.
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    for child in body.iterchildren():
        if child.tag == W_NS + 'tbl':
            doc.paragraphs.append({'i': None, 'kind': 'table', 'text': '', 'loc': f'表格（段落 {i} 之后）'})
            continue
        if child.tag != W_NS + 'p':
            continue
        p = Paragraph(child, d)
        i += 1
        text = p.text
        has_image = bool(child.findall('.//' + W_NS + 'drawing')) or bool(child.findall('.//{urn:schemas-microsoft-com:vml}imagedata'))
        runs = [_run_props(r, p, defaults) for r in p.runs if r.text.strip()]
        unit = {'i': i, 'kind': 'image' if has_image and not text.strip() else 'para', 'text': text, 'style': p.style.name if p.style is not None else '',
                'level': _heading_level(p), 'runs': runs, 'loc': f'段落 {i}', 'align': str(p.alignment) if p.alignment is not None else None, 'image': has_image}
        doc.paragraphs.append(unit)
        doc.offsets.append((pos, '段落', i))
        texts.append(text + '\n')
        pos += len(text) + 1
    doc.text = ''.join(texts)
    _structure_from_units(doc)
    try:
        cp = d.core_properties
        doc.meta['docx_author'] = cp.author or ''
        doc.meta['docx_last_modified_by'] = cp.last_modified_by or ''
    except Exception:  # pragma: no cover
        pass
    return doc


# ------------------------------------------------------------ Markdown / text

def load_markdown(path: Path) -> Doc:
    doc = Doc(path=path.resolve(), kind='markdown' if path.suffix.lower() != '.txt' else 'text', root=path.resolve().parent)
    pos = 0
    texts = []
    for n, line in enumerate(path.read_text(encoding='utf-8', errors='replace').splitlines(), 1):
        h = re.match(r'^(#{1,6})\s+(.*)$', line)
        doc.paragraphs.append({'i': n, 'kind': 'para', 'text': h.group(2) if h else line, 'level': len(h.group(1)) if h else None,
                               'style': 'heading' if h else '', 'runs': [], 'loc': f'{path.name}:{n}', 'image': bool(re.search(r'!\[[^\]]*\]\(', line))})
        doc.offsets.append((pos, path.name, n))
        texts.append(line + '\n')
        pos += len(line) + 1
    doc.text = ''.join(texts)
    _structure_from_units(doc)
    return doc


_CAPTION = re.compile(r'^\s*(图|表|Figure|Fig\.|Table|TABLE)\s*([A-Z]?\d+(?:\s*[.\-–]\s*\d+)*)\s*[.:：]?\s*(.*)$')
_EQNO = re.compile(r'[（(]\s*(\d+(?:\s*[.\-–]\s*\d+)?)\s*[)）]\s*$')
_NUMCITE = re.compile(r'\[(\d+(?:\s*[-–~～,，]\s*\d+)*)\]')


def _expand_numbers(s: str) -> list[int]:
    out = []
    for part in re.split(r'[,，]', s):
        part = part.strip()
        m = re.fullmatch(r'(\d+)\s*[-–~～]\s*(\d+)', part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            out += list(range(a, b + 1)) if 0 < b - a < 200 else [a, b]
        elif part.isdigit():
            out.append(int(part))
    return out


def _norm_title(s: str) -> str:
    return re.sub(r'\s+', '', s or '').lower()


def _structure_from_units(doc: Doc) -> None:
    """Sections, captions, equation numbers, numeric citations, reference list, abstract/keywords
    for paragraph-based formats (Word, Markdown)."""
    units = [u for u in doc.paragraphs if u['kind'] != 'table']
    in_refs = False
    ref_heading = re.compile(r'^(参考文献|references|bibliography|引用文献)$', re.I)
    abstract_zh = abstract_en = None
    for u in units:
        t = u['text'].strip()
        if not t:
            continue
        title_key = _norm_title(t)
        is_heading = u['level'] is not None
        if is_heading:
            doc.sections.append({'level': u['level'], 'title': t, 'loc': u['loc'], 'i': u['i']})
            in_refs = bool(ref_heading.match(title_key))
            abstract_zh = 'zh' if title_key in ('摘要',) else None
            abstract_en = 'en' if title_key == 'abstract' else None
            continue
        if in_refs:
            m = re.match(r'^\s*[\[［](\d+)[\]］]\s*(.+)$|^\s*(\d+)[.、]\s+(.+)$', t)
            n = int(m.group(1) or m.group(3)) if m else None
            doc.bib.append({'n': n, 'raw': ((m.group(2) or m.group(4)) if m else t).strip(), 'loc': u['loc'], 'i': u['i'], '_block': len(doc.sections)})
            continue
        m = _CAPTION.match(t)
        if m and len(t) < 160:
            kind = 'figure' if m.group(1) in ('图', 'Figure', 'Fig.') else 'table'
            doc.floats.append({'kind': kind, 'number': re.sub(r'\s+', '', m.group(2)), 'caption': m.group(3), 'loc': u['loc'], 'i': u['i']})
        e = _EQNO.search(t)
        if e and len(t) < 200 and not HAS_CJK.search(t[:max(0, e.start())][-20:] or ''):
            doc.equations.append({'number': re.sub(r'\s+', '', e.group(1)), 'loc': u['loc']})
        for c in _NUMCITE.finditer(t):
            doc.cites.append({'keys': _expand_numbers(c.group(1)), 'loc': u['loc'], 'i': u['i']})
        kw = re.match(r'^\s*(关键词|关键字|Key\s*words|Keywords|Index Terms)\s*[:：—\-]\s*(.+)$', t, re.I)
        if kw:
            lang = 'zh' if HAS_CJK.search(kw.group(1)) else 'en'
            doc.meta['keywords' if lang == 'zh' else 'keywords_en'] = [k.strip() for k in re.split(r'[;；,，]', kw.group(2)) if k.strip()]
            doc.meta[('keywords' if lang == 'zh' else 'keywords_en') + '_sep'] = '；' if '；' in kw.group(2) else ';' if ';' in kw.group(2) else '，' if '，' in kw.group(2) else ','
            doc.meta[('keywords' if lang == 'zh' else 'keywords_en') + '_loc'] = u['loc']
            abstract_zh = abstract_en = None
            continue
        if abstract_zh:
            doc.meta['abstract'] = (doc.meta.get('abstract', '') + t)
            doc.meta.setdefault('abstract_loc', u['loc'])
        elif abstract_en:
            doc.meta['abstract_en'] = (doc.meta.get('abstract_en', '') + ' ' + t).strip()
            doc.meta.setdefault('abstract_en_loc', u['loc'])
    # In a reference section that has numbered entries, unnumbered paragraphs are notes / instructions.
    blocks = {b['_block'] for b in doc.bib if b.get('n')}
    looks_like_ref = lambda r: bool(re.search(r'(?<!\d)(19|20)\d{2}(?!\d)', r)) and (r.count('.') + r.count('．') >= 2 or bool(_GBT_ANY_CODE.search(r)))
    doc.bib = [b for b in doc.bib if b.get('n') or (b['_block'] not in blocks and looks_like_ref(b['raw']))]
    for b in doc.bib:
        b.pop('_block', None)
    ack = next((s for s in doc.sections if _norm_title(s['title']) in ('致谢', 'acknowledgments', 'acknowledgements', 'acknowledgment')), None)
    if ack:
        doc.meta['ack_loc'] = ack['loc']


# ------------------------------------------------------------ PDF

def load_pdf(path: Path) -> Doc:
    try:
        import pymupdf as fitz
    except ImportError:  # pragma: no cover
        import fitz
    doc = Doc(path=path.resolve(), kind='pdf', root=path.resolve().parent)
    pages = []
    texts = []
    pos = 0
    with fitz.open(path) as pdf:
        doc.pdf['metadata'] = {k: v for k, v in (pdf.metadata or {}).items() if v}
        doc.pdf['page_count'] = pdf.page_count
        for n, page in enumerate(pdf, 1):
            t = page.get_text('text')
            pages.append({'page': n, 'lines': [l.strip() for l in t.splitlines() if l.strip()], 'chars': len(t.strip())})
            doc.offsets.append((pos, 'p.', n))
            texts.append(t + '\n')
            pos += len(t) + 1
    doc.text = ''.join(texts)
    doc.pdf['pages'] = pages
    heading = re.compile(r'^(?:(\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\.?\s+)?([A-Z][A-Za-z ,&\-]{2,60}|[\u4e00-\u9fff]{2,12})$')
    for pg in pages:
        for line in pg['lines'][:80]:
            m = heading.match(line)
            if m and (m.group(1) or line.lower() in ('references', 'bibliography', 'acknowledgments', 'acknowledgements', 'appendix', 'abstract')):
                doc.sections.append({'level': (m.group(1) or '').count('.') + 1 if m.group(1) else 1, 'title': m.group(2).strip(),
                                     'number': m.group(1), 'loc': f'p.{pg["page"]}', 'page': pg['page']})
    return doc


def pdf_section_pages(path: str | Path, headings: Iterable[str] = ('References', 'Appendix', 'Acknowledgments')) -> dict:
    """Page count and the first page on which each heading appears as a line of its own
    (case-insensitive; numbered forms like 'A Appendix' or '7 References' also match)."""
    doc = load_pdf(Path(path))
    out = {'page_count': doc.pdf['page_count'], 'metadata': doc.pdf['metadata'], 'starts': {}}
    for h in headings:
        pat = re.compile(r'^(?:[A-Z\d]+(?:\.\d+)*\.?\s+)?' + re.escape(h) + r's?\s*$', re.I)
        for pg in doc.pdf['pages']:
            if any(pat.match(l) for l in pg['lines']):
                out['starts'][h] = pg['page']
                break
    return out


# ============================================================ checks

CHECKS: dict[str, Callable[..., list]] = {}


def check(name: str):
    def deco(f):
        CHECKS[name] = f
        return f
    return deco


_COUNTER = re.compile(r'(不可写成|不可写作|不写成|不写作|不要写成|而不是|而非|错误写法|误写为|×)\s*[：:]?\s*[「『“"‘\']?\s*$')


def _counterexample(text: str, start: int) -> bool:
    """The match is quoted as a wrong example (e.g. 「不可写成15～20%」)."""
    return bool(_COUNTER.search(text[max(0, start - 12):start]))


def _cjk_count(s: str) -> int:
    return len(re.findall(f'[{CJK}]', s or ''))


def _title_length(s: str) -> int:
    """Characters as a Chinese reader counts them: each CJK character, and each Latin word / number as one."""
    return _cjk_count(s) + len(re.findall(r'[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)*', s or ''))


@check('latex_labels_refs')
def _labels_refs(doc: Doc, p: dict, rule: dict) -> list:
    if doc.kind != 'latex':
        return []
    out = []
    first: dict[str, dict] = {}
    for lab in doc.labels:
        if lab['name'] in first:
            out.append(finding(rule['id'] + '.duplicate_label', 'error', lab['loc'], f'标签 {lab["name"]} 重复定义（首次在 {first[lab["name"]]["loc"]}）', lab['name']))
        else:
            first[lab['name']] = lab
    for r in doc.refs:
        if r['name'] not in first:
            out.append(finding(rule['id'] + '.unresolved_ref', 'error', r['loc'], f'\\{r["cmd"]}{{{r["name"]}}} 引用了不存在的标签', r['name']))
    for g in doc.graphics:
        if not g['exists']:
            out.append(finding(rule['id'] + '.missing_figure', 'error', g['loc'], f'图形文件不存在：{g["path"]}', g['path']))
    return out


@check('citations_resolve')
def _citations(doc: Doc, p: dict, rule: dict) -> list:
    out = []
    if doc.kind == 'latex':
        keys = {b.get('key') for b in doc.bib}
        if not doc.bib and doc.cites:
            return [finding(rule['id'], 'warning', doc.cites[0]['loc'], '有 \\cite 但没有找到参考文献库（.bib 或 thebibliography）')]
        cited = set()
        for c in doc.cites:
            for k in c['keys']:
                cited.add(k)
                if k not in keys and k != '*':
                    out.append(finding(rule['id'] + '.undefined', 'error', c['loc'], f'引用键 {k} 在参考文献库里不存在', k))
        if p.get('report_uncited', True) and not any(c['cmd'] == 'nocite' and '*' in c['keys'] for c in doc.cites):
            for b in doc.bib:
                if 'cited' in b:   # .bib database: BibTeX prints only cited entries, extra ones are harmless
                    continue
                if b.get('key') not in cited:
                    out.append(finding(rule['id'] + '.uncited', 'info', b.get('loc', ''), f'参考文献 {b.get("key")} 在正文中没有被引用', b.get('key', '')))
    else:
        nums = {b['n'] for b in doc.bib if b.get('n')}
        if doc.bib and nums:
            cited = set()
            for c in doc.cites:
                for n in c['keys']:
                    cited.add(n)
                    if n not in nums:
                        out.append(finding(rule['id'] + '.undefined', 'error', c['loc'], f'引用 [{n}] 在参考文献表里不存在', str(n)))
            for b in doc.bib:
                if b.get('n') and b['n'] not in cited:
                    out.append(finding(rule['id'] + '.uncited', 'warning', b['loc'], f'参考文献 [{b["n"]}] 在正文中没有被引用', b['raw'][:60]))
    return out


@check('citation_order')
def _citation_order(doc: Doc, p: dict, rule: dict) -> list:
    """Numeric system: references numbered in order of first citation."""
    if doc.kind == 'latex':
        ok = p.get('latex_styles', ['unsrt', 'unsrtnat', 'ieeetr', 'IEEEtran', 'gbt7714-numerical', 'gbt7714-2005-numerical', 'unsrtnat', 'splncs04', 'abbrv-unsrt', 'naturemag', 'osajnl', 'opticajnl'])
        numeric_gbt = bool(doc.bibstyle and re.match(r'gbt7714', doc.bibstyle) and not re.search(r'author|year', doc.bibstyle))
        if doc.bibstyle and doc.bibstyle not in ok and not numeric_gbt and doc.bib_files:
            return [finding(rule['id'], 'warning', '', f'\\bibliographystyle{{{doc.bibstyle}}} 可能不按引用顺序编号；要求按正文首次引用顺序排列', doc.bibstyle)]
        return []
    seen: list[int] = []
    out = []
    for c in doc.cites:
        for n in c['keys']:
            if n in seen:
                continue
            expected = len(seen) + 1
            if n > expected:   # cited before lower-numbered references: report the early one only
                out.append(finding(rule['id'], 'warning', c['loc'], f'文献 [{n}] 首次被引用时应编号为 [{expected}]（按正文首次引用顺序编号）', f'[{n}]'))
                if len(out) >= 5:
                    seen.append(n)
                    return out
            seen.append(n)
    return out


STANDARD_ENVS = {'document', 'appendix', 'appendices', 'center', 'flushleft', 'flushright', 'minipage', 'landscape', 'sidewaysfigure',
                 'sidewaystable', 'multicols', 'small', 'footnotesize', 'scriptsize', 'large', 'subappendices', 'frame', 'adjustwidth'}


def _enclosing_env(text: str, offset: int) -> str | None:
    """Innermost environment that is open at `offset`."""
    stack: list[str] = []
    for m in re.finditer(r'\\(begin|end)\s*\{([^}]+)\}', text[:offset]):
        if m.group(1) == 'begin':
            stack.append(m.group(2))
        elif stack and stack[-1] == m.group(2):
            stack.pop()
    return stack[-1] if stack else None


@check('float_numbering')
def _float_numbering(doc: Doc, p: dict, rule: dict) -> list:
    """Figures / tables / equations numbered consecutively (overall or per chapter) and referenced in the text."""
    out = []
    if doc.kind == 'latex':
        refd = {r['name'] for r in doc.refs}
        for m in re.finditer(r'\\(?:ref|cref|autoref)\{([^}]*?)(\d+)\}\s*(?:-{1,3}|–|—|to|~?--~?)\s*\\(?:ref|cref|autoref)\{([^}]*?)(\d+)\}', doc.text):
            if m.group(1) == m.group(3) and int(m.group(2)) < int(m.group(4)) <= int(m.group(2)) + 50:
                refd |= {f'{m.group(1)}{k}' for k in range(int(m.group(2)), int(m.group(4)) + 1)}
        for f in doc.floats:
            if f['caption'] is None:
                env = _enclosing_env(doc.text, f.get('offset', 0))
                if env and env not in STANDARD_ENVS:
                    continue   # inside a template environment (e.g. paperRelation) that supplies its own heading
                out.append(finding(rule['id'] + '.caption', 'warning', f['loc'], f'{"图" if f["kind"] == "figure" else "表"}没有 \\caption'))
            elif f['label'] is None:
                out.append(finding(rule['id'] + '.unreferenced', 'info', f['loc'], f'{"图" if f["kind"] == "figure" else "表"}「{f["caption"][:20]}」没有 \\label，正文无法引用'))
            elif not any(l in refd for l in (f.get('labels') or [f['label']])):
                out.append(finding(rule['id'] + '.unreferenced', 'warning', f['loc'], f'{"图" if f["kind"] == "figure" else "表"} {f["label"]} 没有在正文中被引用', f['label']))
        return out
    per_chapter = p.get('per_chapter')
    for kind, name in (('figure', '图'), ('table', '表')):
        items = [f for f in doc.floats if f['kind'] == kind]
        prev = None
        for f in items:
            parts = [int(x) for x in re.split(r'[.\-–]', f['number']) if x.isdigit()]
            if not parts:
                continue
            if prev is not None:
                if len(parts) == 2 and len(prev) == 2:
                    ok = (parts[0] == prev[0] and parts[1] == prev[1] + 1) or (parts[0] > prev[0] and parts[1] == 1)
                else:
                    ok = parts[-1] == prev[-1] + 1
                if not ok:
                    out.append(finding(rule['id'] + '.sequence', 'warning', f['loc'], f'{name} {f["number"]} 编号不连续（前一个是 {name} {".".join(map(str, prev))}）', f['number']))
            elif parts[-1] != 1:
                out.append(finding(rule['id'] + '.sequence', 'warning', f['loc'], f'第一个{name}编号为 {f["number"]}', f['number']))
            if per_chapter and len(parts) < 2:
                out.append(finding(rule['id'] + '.per_chapter', 'warning', f['loc'], f'{name} {f["number"]} 应按章编号（如 {name}3-1 或 {name}3.1）', f['number']))
            prev = parts
            # referenced in the text (anywhere other than the caption itself)
            num = f['number']
            pat = re.compile(r'(图|表|Fig\.?|Figure|Table)\s*' + re.escape(num).replace(r'\-', r'[.\-–]').replace(r'\.', r'[.\-–]') + r'(?!\d)')
            mentions = [u for u in doc.paragraphs if u.get('i') != f.get('i') and pat.search(u['text'] or '')]
            if not mentions:
                out.append(finding(rule['id'] + '.unreferenced', 'warning', f['loc'], f'{name} {num} 没有在正文中被引用', num))
        styles = {('dash' if '-' in f['number'] else 'dot' if '.' in f['number'] else 'plain') for f in items}
        if len(styles) > 1:
            out.append(finding(rule['id'] + '.style', 'warning', items[0]['loc'], f'{name}的编号格式不统一（混用了 3-1 与 3.1 等写法）'))
    return out


@check('caption_position')
def _caption_position(doc: Doc, p: dict, rule: dict) -> list:
    """Word / Markdown: table caption above the table, figure caption below the image (configurable)."""
    if doc.kind not in ('docx', 'markdown'):
        return []
    out = []
    units = doc.paragraphs
    for k, u in enumerate(units):
        m = _CAPTION.match(u.get('text') or '')
        if not m or len(u['text']) > 160:
            continue
        kind = 'figure' if m.group(1) in ('图', 'Figure', 'Fig.') else 'table'
        want = p.get(kind)  # 'above' | 'below'
        if not want:
            continue
        def nearest(direction):
            j = k + direction
            while 0 <= j < len(units) and not (units[j].get('text') or '').strip() and units[j]['kind'] == 'para' and not units[j].get('image'):
                j += direction
            return units[j] if 0 <= j < len(units) else None
        below, above = nearest(1), nearest(-1)
        target = 'table' if kind == 'table' else 'image'
        is_t = lambda x: x is not None and (x['kind'] == target or (target == 'image' and x.get('image')))
        if want == 'above' and not is_t(below) and is_t(above):
            out.append(finding(rule['id'], 'warning', u['loc'], f'{"表" if kind == "table" else "图"}题应在{"表格" if kind == "table" else "图"}上方', u['text'][:30]))
        if want == 'below' and not is_t(above) and is_t(below):
            out.append(finding(rule['id'], 'warning', u['loc'], f'{"表" if kind == "table" else "图"}题应在{"表格" if kind == "table" else "图"}下方', u['text'][:30]))
    return out


_ACR = re.compile(r'(?<![A-Za-z\\{])([A-Z][A-Za-z]*[A-Z][A-Za-z0-9]*|[A-Z]{2,})s?(?![A-Za-z])')
_ACR_DEF = re.compile(r'([A-Za-z][A-Za-z\- ]{2,80}?|[\u4e00-\u9fff]{2,30})\s*[(（]\s*([A-Z][A-Za-z0-9\-]*[A-Z][A-Za-z0-9]*s?|[A-Z]{2,}s?)\s*[)）;；,，]')
_ACR_DEF_EN = re.compile(r'[(（]\s*([A-Za-z][A-Za-z\-\s’\']{2,80}?)\s*[,，]\s*([A-Z][A-Za-z0-9\-]*[A-Z][A-Za-z0-9]*s?|[A-Z]{2,}s?)\s*[)）]')
COMMON_ACRONYMS = {'AI', 'PDF', 'URL', 'ID', 'OK', 'USA', 'UK', 'EU', 'PhD', 'MSc', 'BSc', 'IEEE', 'ACM', 'DOI', 'ISBN', 'ISSN', 'LaTeX', 'TeX',
                   'CPU', 'GPU', 'RAM', 'GB', 'MB', 'KB', 'TB', 'API', 'HTTP', 'HTTPS', 'HTML', 'XML', 'JSON', 'CSV', 'SVG', 'PNG', 'JPEG',
                   'TIFF', 'EPS', 'ASCII', 'UTF', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII', 'AM', 'PM', 'Fig', 'Eq', 'Eqs',
                   'NeurIPS', 'ICML', 'ICLR', 'CVPR', 'ICCV', 'ECCV', 'AAAI', 'IJCAI', 'ACL', 'EMNLP', 'SPIE', 'OSA', 'GitHub', 'arXiv',
                   'MATLAB', 'COMSOL', 'NVIDIA', 'CUDA', 'Python', 'PyTorch', 'TensorFlow', 'CMOS', 'IoT'}


def _initials_match(full: str, ab: str) -> bool:
    """Do the abbreviation's letters appear, in order, as initials of the words just before it?
    All-caps word parts contribute every letter (preference-based RL → p b r l → PbRL)."""
    if HAS_CJK.search(full):
        return True
    letters = [c for c in ab.lower() if c.isalpha()]
    parts = [w for w in re.split(r'[\s\-–/]+', full.strip()) if w][- (len(letters) + 4):]
    inits = []
    for w in parts:
        if re.fullmatch(r'[A-Z]{2,}s?', w):
            inits += list(w.rstrip('s').lower())
        elif w[0].isalpha():
            inits.append(w[0].lower())
    if not inits or not letters or inits[-1] == '' :
        return False
    # letters must be a subsequence of the initials, starting at one of the (last few) words
    for start in range(0, len(inits)):
        if inits[start] != letters[0]:
            continue
        k = 0
        for c in inits[start:]:
            if k < len(letters) and c == letters[k]:
                k += 1
        if k == len(letters):
            return True
    # compound words: 'Multilayer perceptron' → MLP, 'Deep auto-regressive' → DeepAR
    words = [w for w in re.split(r'[\s/]+', full.strip()) if w][-(len(letters) + 1):]
    for start, w in enumerate(words):
        if not w or w[0].lower() != letters[0]:
            continue
        flat = ''.join(words[start:]).lower()
        k = 0
        for c in flat:
            if k < len(letters) and c == letters[k]:
                k += 1
        if k == len(letters) and words[-1][0].isalpha():
            return True
    return False


def _plain(doc: Doc) -> str:
    t = doc.text
    if doc.kind == 'latex':
        body = re.search(r'\\begin\{document\}', t)
        if body:   # preamble: macro definitions, package options
            t = ' ' * body.end() + t[body.end():]
        t = re.sub(r'\\(?:re)?newcommand\*?\s*\{?\\[a-zA-Z@]+\}?\s*(?:\[\d\])?\s*\{(?:[^{}]|\{[^{}]*\})*\}', lambda m: ' ' * len(m.group(0)), t)
        t = re.sub(r'\$\$|\$[^$\n]*\$|\\\(.*?\\\)|\\\[.*?\\\]', lambda m: ' ' * len(m.group(0)), t, flags=re.S)
        t = re.sub(r'\\begin\{(equation|align|gather|multline|eqnarray|verbatim|lstlisting|minted)\*?\}.*?\\end\{\1\*?\}', lambda m: ' ' * len(m.group(0)), t, flags=re.S)
        t = re.sub(r'\\(label|ref|eqref|cref|Cref|autoref|cite[a-zA-Z]*|includegraphics|usepackage|documentclass|bibliography|bibliographystyle|input|include|url|href|graphicspath)\*?\s*(\[[^\]]*\])?\s*\{[^}]*\}', lambda m: ' ' * len(m.group(0)), t)
        blank = lambda m: ' ' * len(m.group(0))
        t = re.sub(r'\\(?:v|h)space\*?\s*\{[^}]*\}|\\(?:vskip|hskip|kern|vspace)\s*-?[\d.]+\s*[a-z]{2}|\\(?:setlength|addtolength)\s*\{[^}]*\}\s*\{[^}]*\}', blank, t)
        t = re.sub(r'(\\begin\{(?:tabular|tabularx|tabulary|array|longtable|tabu)\*?\})(\s*\{[^{}]*\})?\s*\{(?:[^{}]|\{[^{}]*\})*\}', blank, t)   # column specs P{0.9cm}
        t = re.sub(r'(\\[a-zA-Z@]+\*?)\s*\[[^\]\n]*\]', lambda m: ' ' * len(m.group(0)), t)   # command options like [width=2mm]
        t = re.sub(r'\\[a-zA-Z@]+', blank, t)
        t = t.replace('{', ' ').replace('}', ' ')
    return t


def _ref_section_start(doc: Doc) -> int | None:
    """Offset where the reference list starts (to exclude it from body-text checks)."""
    if doc.kind == 'latex':
        m = re.search(r'\\begin\{thebibliography\}|\\bibliography\s*\{|\\printbibliography', doc.text)
        return m.start() if m else None
    for s in doc.sections:
        if re.match(r'^(参考文献|references|bibliography)$', _norm_title(s['title']), re.I):
            u = next((u for u in doc.paragraphs if u.get('i') == s.get('i')), None)
            if u is not None:
                idx = doc.paragraphs.index(u)
                return sum(len((x.get('text') or '')) + 1 for x in doc.paragraphs[:idx] if x['kind'] != 'table')
    return None


@check('abbreviations')
def _abbreviations(doc: Doc, p: dict, rule: dict) -> list:
    """Abbreviations defined at first use ('Full Name (ABC)'); same abbreviation not defined two ways."""
    text = _plain(doc)
    stop = _ref_section_start(doc)
    if stop:
        text = text[:stop]
    allow = COMMON_ACRONYMS | set(p.get('allow', []))
    well_known = set(p.get('well_known', []))
    text = re.sub(r'\bTL;DR\b', lambda m: ' ' * len(m.group(0)), text)
    norm = lambda a: a[:-1] if a.endswith('s') and sum(ch.isupper() for ch in a[:-1]) >= 2 else a
    defs: dict[str, tuple[int, str]] = {}
    out = []
    found_defs = sorted(list(_ACR_DEF.finditer(text)) + list(_ACR_DEF_EN.finditer(text)), key=lambda m: m.start(2))
    for m in found_defs:
        ab = norm(m.group(2))
        full = m.group(1).strip()
        if not _initials_match(full, ab):
            continue
        if ab in defs:
            prev_full = defs[ab][1]
            key = lambda s: re.sub(r'[^a-z\u4e00-\u9fff]', '', s.lower())[-24:]
            a_, b_ = key(prev_full), key(full)
            common = 0
            while common < min(len(a_), len(b_)) and a_[-1 - common] == b_[-1 - common]:
                common += 1
            same = (common >= (4 if HAS_CJK.search(a_ + b_) else 8) or a_.endswith(b_) or b_.endswith(a_)
                    or bool(HAS_CJK.search(a_)) != bool(HAS_CJK.search(b_)))   # 中文全称 vs English full name
            if a_ and b_ and not same:
                out.append(finding(rule['id'] + '.conflict', 'warning', doc.loc(m.start()), f'缩写 {ab} 前后定义不一致：「{prev_full[-30:]}」与「{full[-30:]}」', ab))
            continue
        defs[ab] = (m.start(2), full)
    first_use: dict[str, int] = {}
    counts: dict[str, int] = {}
    spans = []
    if doc.kind == 'latex':
        for am in re.finditer(r'\\(?:cabstract|eabstract)\s*\{|\\begin\{abstract\}', doc.text):
            if am.group(0).startswith('\\begin'):
                e = doc.text.find('\\end{abstract}', am.end())
                spans.append((am.start(), e if e > 0 else am.end()))
            else:
                arg = _balanced(doc.text, am.end() - 1)
                spans.append((am.start(), arg[1] if arg else am.end()))
    in_abstract = lambda pos: any(a <= pos < b for a, b in spans)
    for m in _ACR.finditer(text):
        ab = norm(m.group(0).strip())
        a0, a1 = m.start(), m.end()
        if re.match(r'[A-Za-z]-', text[max(0, a0 - 2):a0]) or re.match(r'-\d|-[A-Z]|/[A-Z]', text[a1:a1 + 2]) or re.search(r'[A-Za-z]/$', text[max(0, a0 - 2):a0]):
            continue
        if ab in allow or len(ab) > 10 or not re.search(r'[A-Z].*[A-Z]', ab) or re.fullmatch(r'(.)\1+', ab):
            continue
        counts[ab] = counts.get(ab, 0) + 1
        if not in_abstract(m.start()):
            first_use.setdefault(ab, m.start())
    min_uses = p.get('min_uses', 2)
    reported = 0
    for ab, pos in sorted(first_use.items(), key=lambda kv: kv[1]):
        if ab in defs:
            if pos < defs[ab][0] - 1:
                out.append(finding(rule['id'] + '.before_definition', 'warning', doc.loc(pos), f'缩写 {ab} 在定义（{doc.loc(defs[ab][0])}）之前就已使用', ab))
        elif counts[ab] >= min_uses and ab not in well_known:
            out.append(finding(rule['id'] + '.undefined', 'info', doc.loc(pos), f'缩写 {ab} 出现 {counts[ab]} 次，未见首次出现时的全称定义（如果是公知缩写可忽略）', ab))
        reported += 1
        if reported > 40:
            break
    return out


_UNITS = r'(?:nm|µm|μm|um|mm|cm|km|ms|µs|μs|ns|ps|fs|Hz|kHz|MHz|GHz|THz|dB|dBm|mW|µW|μW|kW|MW|mV|kV|mA|µA|μA|nA|eV|meV|keV|Gbps|Mbps|Gb/s|Mb/s|pJ|fJ|nJ|mJ|°C|K)'


@check('number_unit_space')
def _number_unit_space(doc: Doc, p: dict, rule: dict) -> list:
    """A space separates the number and the unit symbol (except °, ′, ″)."""
    text = _plain(doc)
    stop = _ref_section_start(doc)
    if stop:
        text = text[:stop]
    out = []
    for m in re.finditer(r'(?<![\w.])(\d+(?:\.\d+)?)(' + _UNITS + r')(?![A-Za-z0-9])', text):
        if m.group(2) == 'K' and re.fullmatch(r'\d{4,}', m.group(1)):
            continue
        out.append(finding(rule['id'], 'warning', doc.loc(m.start()), f'数值与单位之间应有空格：{m.group(0)} → {m.group(1)} {m.group(2)}', m.group(0)))
        if len(out) >= p.get('max', 20):
            break
    return out


@check('range_style')
def _range_style(doc: Doc, p: dict, rule: dict) -> list:
    """Chinese style: '800～1500 m³/s' (unit once), '15%～20%' (both percent signs), '3 800 000' (no thousands commas)."""
    text = _plain(doc)
    stop = _ref_section_start(doc)
    if stop:
        text = text[:stop]
    out = []
    if p.get('percent_both', True):
        for m in re.finditer(r'(?<![\d.%])(\d+(?:\.\d+)?)\s*[~～\-–]\s*(\d+(?:\.\d+)?)\s*%', text):
            if _counterexample(text, m.start()):
                continue
            out.append(finding(rule['id'] + '.percent', 'warning', doc.loc(m.start()), f'百分数范围两个数都要带 %：{m.group(0)} → {m.group(1)}%～{m.group(2)}%', m.group(0)))
    if p.get('unit_once', True):
        for m in re.finditer(r'(\d+(?:\.\d+)?)\s*([A-Za-zµμ°/]+[A-Za-z0-9/³²]*)\s*[~～–]\s*(\d+(?:\.\d+)?)\s*\2(?![A-Za-z])', text):
            if _counterexample(text, m.start()):
                continue
            out.append(finding(rule['id'] + '.unit', 'info', doc.loc(m.start()), f'范围只需在后一个数值后写一次单位：{m.group(0)} → {m.group(1)}～{m.group(3)} {m.group(2)}', m.group(0)))
    if p.get('no_thousands_comma', False):
        for line_m in re.finditer(r'[^\n]+', text):
            line = line_m.group(0)
            if not HAS_CJK.search(line):
                continue
            for m in re.finditer(r'(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,])', line):
                if _counterexample(line, m.start()):
                    continue
                out.append(finding(rule['id'] + '.thousands', 'info', doc.loc(line_m.start() + m.start()), f'科技文本中多位数不用千分撇，用空格分节或「万」：{m.group(0)}', m.group(0)))
    return out[: p.get('max', 30)]


@check('cjk_punctuation')
def _cjk_punct(doc: Doc, p: dict, rule: dict) -> list:
    """Chinese sentences use full-width punctuation; English sentences use half-width."""
    text = _plain(doc)
    stop = _ref_section_start(doc)
    if stop:
        text = text[:stop]
    out = []
    half = re.compile(f'(?<=[{CJK}])\\s*([,;:?!])|([,;:?!])\\s*(?=[{CJK}])|(?<=[{CJK}])\\.(?![\\dA-Za-z])')
    full = re.compile(r'(?<=[A-Za-z0-9])\s*([，。；：？！])\s*(?=[A-Za-z])')
    for line_m in re.finditer(r'[^\n]+', text):
        line = line_m.group(0)
        if HAS_CJK.search(line):
            for m in half.finditer(line):
                ch = (m.group(1) or m.group(2) or '.')
                out.append(finding(rule['id'] + '.half_in_zh', 'info', doc.loc(line_m.start() + m.start()), f'中文语句里用了半角标点「{ch}」', line[max(0, m.start() - 8): m.end() + 8]))
        else:
            for m in full.finditer(line):
                out.append(finding(rule['id'] + '.full_in_en', 'info', doc.loc(line_m.start() + m.start()), f'英文语句里用了全角标点「{m.group(1)}」', line[max(0, m.start() - 8): m.end() + 8]))
        if len(out) >= p.get('max', 30):
            break
    return out


@check('title_length')
def _title_len(doc: Doc, p: dict, rule: dict) -> list:
    title = p.get('title') or doc.meta.get('title')
    if not title:
        return [finding(rule['id'], 'info', '', '没有识别出题名，无法检查长度（Word 稿件可在报告里手动核对）')] if p.get('report_missing') else []
    n = _title_length(title)
    if n > p['max']:
        return [finding(rule['id'], 'warning', doc.meta.get('title_loc', ''), f'题名 {n} 字，超过 {p["max"]} 字', title[:60])]
    return []


@check('abstract_length')
def _abstract_len(doc: Doc, p: dict, rule: dict) -> list:
    lang = p.get('lang', 'zh')
    text = doc.meta.get('abstract' if lang == 'zh' else 'abstract_en') or (doc.meta.get('abstract') if lang == 'en' and not HAS_CJK.search(doc.meta.get('abstract', '')) else None)
    if not text:
        return [finding(rule['id'], 'info', '', f'没有识别出{"中文" if lang == "zh" else "英文"}摘要')] if p.get('report_missing', True) else []
    n = _cjk_count(text) if lang == 'zh' else len(re.findall(r"[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*", text))
    unit = '字' if lang == 'zh' else ' words'
    lo, hi = p.get('min'), p.get('max')
    loc = doc.meta.get('abstract_loc' if lang == 'zh' else 'abstract_en_loc', doc.meta.get('abstract_loc', ''))
    if lo and n < lo:
        return [finding(rule['id'], 'warning', loc, f'摘要 {n}{unit}，少于 {lo}{unit}', str(n))]
    if hi and n > hi:
        return [finding(rule['id'], 'warning', loc, f'摘要 {n}{unit}，多于 {hi}{unit}', str(n))]
    return []


@check('keywords')
def _keywords(doc: Doc, p: dict, rule: dict) -> list:
    lang = p.get('lang', 'zh')
    kws = doc.meta.get('keywords' if lang == 'zh' else 'keywords_en')
    if kws is None and lang == 'en':
        kws = doc.meta.get('keywords') if doc.kind == 'latex' else None
    loc = doc.meta.get(('keywords' if lang == 'zh' else 'keywords_en') + '_loc', '')
    if kws is None:
        return [finding(rule['id'], 'warning', '', f'没有找到{"中文" if lang == "zh" else "英文"}关键词')] if p.get('required', True) else []
    out = []
    if p.get('min') and len(kws) < p['min'] or p.get('max') and len(kws) > p['max']:
        out.append(finding(rule['id'] + '.count', 'warning', loc, f'关键词 {len(kws)} 个，应为 {p.get("min")}–{p.get("max")} 个', '；'.join(kws)))
    sep = p.get('separator')
    got = doc.meta.get(('keywords' if lang == 'zh' else 'keywords_en') + '_sep')
    if sep and got and got != sep and len(kws) > 1:
        out.append(finding(rule['id'] + '.separator', 'info', loc, f'关键词之间应使用「{sep}」分隔（现在是「{got}」）'))
    return out


@check('required_sections')
def _required_sections(doc: Doc, p: dict, rule: dict) -> list:
    titles = [_norm_title(s['title']) for s in doc.sections]
    out = []
    for req in p.get('sections', []):
        alts = [_norm_title(a) for a in (req if isinstance(req, list) else [req])]
        if not any(any(t == a or t.endswith(a) or re.sub(r'^[\d.]+', '', t) == a for a in alts) for t in titles):
            out.append(finding(rule['id'], p.get('severity', 'warning'), '', f'缺少必需的部分：{" / ".join(req if isinstance(req, list) else [req])}'))
    return out


@check('section_order')
def _section_order(doc: Doc, p: dict, rule: dict) -> list:
    """Parts that are present must appear in the prescribed order (binding order)."""
    order = [[_norm_title(x) for x in (o if isinstance(o, list) else [o])] for o in p.get('order', [])]
    found = []
    top = min((s['level'] for s in doc.sections if s.get('level') is not None and s['level'] >= 0), default=None)
    for s in doc.sections:
        if top is not None and s.get('level') is not None and s['level'] > top:
            continue
        t = re.sub(r'^[\d.]+', '', _norm_title(s['title']))
        for k, alts in enumerate(order):
            if t in alts:
                found.append((k, s))
                break
    out = []
    for (k1, s1), (k2, s2) in zip(found, found[1:]):
        if k2 < k1:
            out.append(finding(rule['id'], 'warning', s2['loc'], f'「{s2["title"]}」应在「{s1["title"]}」之前（装订 / 章节顺序）'))
    return out


@check('reference_stats')
def _reference_stats(doc: Doc, p: dict, rule: dict) -> list:
    """Thesis reading-volume rules: total count, share of foreign-language and recent references."""
    bib = [b for b in doc.bib if b.get('cited', True)]
    entries = [b.get('raw') or ' '.join(str(b.get(k, '')) for k in ('title', 'authors', 'journal', 'booktitle', 'year')) for b in bib]
    n = len(entries)
    out = []
    if not n:
        return [finding(rule['id'], 'info', '', '没有识别出参考文献表，无法统计文献数量')]
    if p.get('min_total') and n < p['min_total']:
        out.append(finding(rule['id'] + '.total', 'warning', '', f'参考文献 {n} 篇，少于 {p["min_total"]} 篇'))
    foreign = sum(1 for e in entries if not HAS_CJK.search(e))
    if p.get('min_foreign_share') and foreign / n + 1e-9 < p['min_foreign_share']:
        out.append(finding(rule['id'] + '.foreign', 'warning', '', f'外文文献 {foreign}/{n}（{foreign / n:.0%}），低于 {p["min_foreign_share"]:.0%}'))
    if p.get('min_recent_share'):
        this_year = p.get('this_year') or __import__('datetime').date.today().year
        years = []
        for e in entries:
            found = re.findall(r'(?<!\d)(?:19|20)\d{2}(?!\d)', e)
            if found:
                years.append(int(found[-1]))
        recent = sum(1 for y in years if y >= this_year - p.get('recent_years', 5))
        if years and recent / n + 1e-9 < p['min_recent_share']:
            out.append(finding(rule['id'] + '.recent', 'info', '', f'近 {p.get("recent_years", 5)} 年文献 {recent}/{n}（{recent / n:.0%}），低于 {p["min_recent_share"]:.0%}'))
    return out


def _author_block(raw: str) -> str:
    """Leading author list of a reference entry: up to the first '.' that does not close an
    initial (a single capital letter), or up to an opening quote."""
    q = re.search(r'[“"]', raw)
    end = q.start() if q else len(raw)
    for m in re.finditer(r'\.(?:\s|$)|。', raw[:end]):
        before = re.search(r'([A-Za-z\u4e00-\u9fff]+)$', raw[:m.start()])
        if before and (len(before.group(1)) > 1 or HAS_CJK.search(before.group(1))):
            return raw[:m.start()]
    return raw[:end]


# GB/T 7714-2025 Appendix A: Table A.1 type codes, Table A.2 carrier codes.
GBT_TYPES_2025 = ('M', 'J', 'N', 'C', 'D', 'R', 'S', 'P', 'EB', 'A', 'CM', 'DS', 'PP', 'G', 'CP', 'DB', 'Z')
GBT_CARRIERS_2025 = ('MT', 'DK', 'CD', 'OL', 'MM')
_GBT_TYPE = re.compile(r'\[(' + '|'.join(GBT_TYPES_2025) + r')(?:/(' + '|'.join(GBT_CARRIERS_2025) + r'))?\]')
_GBT_ANY_CODE = re.compile(r'\[([A-Z]{1,2})(?:/([A-Z]{2}))?\]')


@check('reference_format')
def _reference_format(doc: Doc, p: dict, rule: dict) -> list:
    """Per-entry reference format for a named style: gbt7714 | hust-grad | ieee | optica."""
    style = p['style']
    out = []
    entries = [b for b in doc.bib if b.get('raw')]
    if doc.kind == 'latex' and not entries:
        return [finding(rule['id'], 'info', '', f'参考文献由 BibTeX 生成：请使用该格式的官方样式文件（{p.get("bst", "见规则包说明")}），本检查只检查手写的参考文献表')]
    for b in entries:
        raw = re.sub(r'\s+', ' ', b['raw']).strip()
        problems = []
        authors_part = _author_block(raw)
        names = [a.strip() for a in re.split(r'[,，](?![^()]*\))', authors_part) if a.strip()]
        has_etal = bool(re.search(r'\bet al\b|等', authors_part))
        name_count = len([n for n in names if not re.search(r'et al|等', n)])
        if style == 'gbt7714':
            code = _GBT_TYPE.search(raw)
            anycode = _GBT_ANY_CODE.search(raw)
            if not code:
                if anycode:
                    problems.append(f'文献类型 / 载体标识 [{anycode.group(0)[1:-1]}] 不在 GB/T 7714-2025 附录 A 的代码表里')
                else:
                    problems.append('缺少文献类型标识（如 [J]、[M]、[C]、[D]、[PP]、[EB]），见 7.3 和附录 A')
            if re.search(r'https?://', raw) and code and not code.group(2):
                problems.append('电子资源除文献类型标识外还应著录载体标识，如 [J/OL]（7.3）')
            if p.get('max_authors') and name_count > p['max_authors'] and not has_etal:
                problems.append(f'责任者超过 {p["max_authors"]} 个时著录前 {p["max_authors"]} 个，后加「，等」或 “et al.”（7.1.2）')
            if re.search(r'\b[A-Z][a-z]+\s+(?:[A-Z]\.\s*)+(?:[,，]|$)|(?:^|[,，]\s*)(?:[A-Z]\.\s*)+[A-Z][a-z]+', authors_part):
                problems.append('西文责任者姓在前、名缩写为首字母且省略缩写点，如 Einstein A、Fordham E W（7.1.1）')
        elif style == 'hust-grad':
            if p.get('max_authors') and name_count > p['max_authors'] and not has_etal:
                problems.append(f'作者超过 {p["max_authors"]} 个时只列前 {p["max_authors"]} 个，后加「等」或 “et al”')
            if re.search(r'[.。,，;；]$', raw):
                problems.append('每条参考文献最后不加标点')
            if not re.search(r'(19|20)\d{2}', raw):
                problems.append('缺少出版年')
        elif style == 'ieee':
            ieee_names = [n for n in re.split(r',\s*|\s+and\s+', re.split(r'[“"]', raw, maxsplit=1)[0]) if re.search(r'[A-Z]\.', n)]
            if len(ieee_names) > p.get('max_authors', 6) and 'et al' not in raw.split('“')[0]:
                problems.append(f'作者超过 {p.get("max_authors", 6)} 个时只写第一作者加 “et al.”')
            if not re.search(r'[“"][^”"]+[”"]', raw) and not re.search(r'\b(Ed\.|Eds\.|ed\.)', raw):
                problems.append('文章题名应放在引号里：“Title,”')
            if re.search(r'^[A-Z][a-z]+,\s+[A-Z]\.', raw):
                problems.append('作者名应写成「名首字母. 姓」（如 J. K. Author），不是「姓, 名」')
            if re.search(r'\b(19|20)\d{2}\b', raw) is None:
                problems.append('缺少年份')
        elif style == 'optica':
            head = re.split(r'[“"]', raw, maxsplit=1)[0]
            o_names = [n for n in re.split(r',\s*|\s+and\s+', head) if re.search(r'[A-Z]\.', n)]
            if len(o_names) > 3 and 'et al' not in head:
                problems.append('作者超过 3 个时只列前 3 个，后加 “et al.”')
            if not re.search(r'\((19|20)\d{2}\)', raw):
                problems.append('年份应放在括号里，如 Appl. Opt. 31, 4973–4980 (1992).')
        if problems:
            out.append(finding(rule['id'], 'warning', b.get('loc', ''), '；'.join(problems), raw[:90]))
        if len(out) >= p.get('max', 40):
            break
    return out


@check('docx_fonts')
def _docx_fonts(doc: Doc, p: dict, rule: dict) -> list:
    """Word: font size / East Asian font of headings by level and of body text."""
    if doc.kind != 'docx':
        return []
    out = []
    spec = p.get('levels', {})
    starts = [u['i'] for u in doc.paragraphs if u.get('level') and _norm_title(u['text']) in ('摘要', 'abstract')]
    first = min(starts) if starts else 0
    ref_paras = {b.get('i') for b in doc.bib}
    for u in doc.paragraphs:
        if u['kind'] != 'para' or not u['text'].strip() or not u['runs'] or (u['i'] or 0) < first or u['i'] in ref_paras:
            continue
        if re.match(r'(toc|目录|索引)', (u.get('style') or '').lower()) or re.match(r'^\s*[*＊]?\s*(表注|图注|注)\s*[：:]', u['text']):
            continue
        key = f'h{u["level"]}' if u['level'] else ('body' if not _CAPTION.match(u['text']) else 'caption')
        want = spec.get(key)
        if not want:
            continue
        sizes = {r['size'] for r in u['runs'] if r['size']}
        easts = {r['east'] for r in u['runs'] if r['east']}
        problems = []
        if want.get('size') and sizes and any(abs(s - pt(want['size'])) > 0.25 for s in sizes):
            problems.append(f'字号 {"/".join(f"{s:g}" for s in sorted(sizes))} pt，应为 {want["size"]}（{pt(want["size"]):g} pt）')
        if want.get('east') and easts and not any(want['east'] in (e or '') for e in easts):
            problems.append(f'中文字体 {"/".join(sorted(e for e in easts if e))}，应为 {want["east"]}')
        if problems:
            out.append(finding(rule['id'] + '.' + key, 'info' if key == 'body' else 'warning', u['loc'], '；'.join(problems), u['text'][:30]))
    # collapse body-text noise: report at most N body findings plus a count
    body = [f for f in out if f['rule'].endswith('.body')]
    if len(body) > p.get('max_body', 5):
        rest = len(body) - p.get('max_body', 5)
        out = [f for f in out if not f['rule'].endswith('.body')] + body[: p.get('max_body', 5)] + [finding(rule['id'] + '.body', 'info', '', f'另有 {rest} 个正文段落字号 / 字体不符，建议统一用样式「正文」设置')]
    return out


@check('anonymity')
def _anonymity(doc: Doc, p: dict, rule: dict) -> list:
    """Double-blind submissions: no author names, acknowledgments, identifying metadata or self-revealing phrases."""
    out = []
    author = doc.meta.get('author')
    if doc.kind == 'latex':
        opts = doc.meta.get('venue_options', '')
        if re.search(r'\b(final|camera|preprint|accepted)\b', opts):
            out.append(finding(rule['id'] + '.mode', 'warning', '', f'会议样式包用了 [{opts}] 选项，投稿版应使用默认（匿名）模式'))
        if author and not re.search(r'anonymous', author, re.I):
            out.append(finding(rule['id'] + '.author_byline', 'error', doc.meta.get('author_loc', ''), '投稿版不能出现作者署名', author[:60]))
    if doc.kind == 'docx' and (doc.meta.get('docx_author') or doc.meta.get('docx_last_modified_by')):
        out.append(finding(rule['id'] + '.metadata', 'warning', 'metadata:Author', 'Word 文件属性里有作者 / 修改者信息', doc.meta.get('docx_author') or doc.meta.get('docx_last_modified_by')))
    if doc.kind == 'pdf':
        md = doc.pdf.get('metadata', {})
        if md.get('author'):
            out.append(finding(rule['id'] + '.pdf_author', 'error', 'metadata:Author', 'PDF 元数据里有作者字段', md['author']))
    if doc.meta.get('ack_loc'):
        hits = _ack_identities(doc)
        if hits:
            for loc, phrase in hits:
                out.append(finding(rule['id'] + '.acknowledgment', 'error', loc, '投稿版的致谢暴露了身份信息（录用后再加致谢）', phrase))
        else:
            out.append(finding(rule['id'] + '.acknowledgment', 'error', doc.meta['ack_loc'], '投稿版不应包含致谢（录用后再加）'))
    text = _plain(doc)
    for m in re.finditer(r'\b(our (previous|prior|earlier) (work|paper|study)|in our (previous|prior) (work|paper)|we previously (showed|proposed))\b|我们(之前|此前|前期)的工作', text, re.I):
        out.append(finding(rule['id'] + '.self_reference', 'warning', doc.loc(m.start()), '可能暴露作者身份的自引表述，改成第三人称', m.group(0)))
    return out


_IDENTITY = re.compile(
    r"((?:[A-Z][A-Za-z&'\-]*\s+){0,5}(?:Lab|Laboratory|Laboratories|University|Institute|Center|Centre|Group|Foundation|Inc\.?|Corporation|Company|Council|Academy|School|College|Department)(?:\s+(?:of|for|and)(?:\s+[A-Z][A-Za-z&'\-]*)+)?)"
    r"|([\u4e00-\u9fff]{2,20}(?:实验室|大学|研究所|研究院|课题组|公司|基金会|基金))"
    r"|((?:grant|Grant|No\.|编号|项目)\s*[A-Z0-9][A-Z0-9\-]{3,})")


def _ack_identities(doc: Doc) -> list[tuple[str, str]]:
    """Identifying phrases (labs, universities, companies, grant numbers) inside the acknowledgment section."""
    out = []
    if doc.kind == 'latex':
        m = re.search(r'\\(?:section|chapter)\*?\s*\{\s*(?:Acknowledg\w*|致\s*谢)\s*\}|\\begin\{(?:ack|acks|acknowledgments?)\}|\\acks\b', doc.text)
        if not m:
            return out
        end = re.search(r'\\(?:section|chapter)\*?\s*\{|\\end\{(?:ack|acks|acknowledgments?|document)\}|\\bibliography', doc.text[m.end():])
        body_start, body = m.end(), doc.text[m.end(): m.end() + (end.start() if end else 3000)]
    else:
        units = doc.paragraphs
        idx = next((k for k, u in enumerate(units) if u.get('level') and _norm_title(u['text']) in ('致谢', 'acknowledgments', 'acknowledgements', 'acknowledgment')), None)
        if idx is None:
            return out
        for u in units[idx + 1:]:
            if u.get('level'):
                break
            for x in _IDENTITY.finditer(u.get('text') or ''):
                out.append((u['loc'], x.group(0).strip()))
        return out
    for x in _IDENTITY.finditer(body):
        out.append((doc.loc(body_start + x.start()), x.group(0).strip()))
    return out


@check('page_limit')
def _page_limit(doc: Doc, p: dict, rule: dict) -> list:
    """PDF: pages before the first excluded section (References / Appendix / Checklist …) within the limit."""
    if doc.kind != 'pdf':
        return [finding(rule['id'], 'info', '', f'页数限制（正文 ≤{p["max_pages"]} 页）请用编译后的 PDF 检查')] if p.get('note_if_not_pdf', True) else []
    pages = doc.pdf['pages']
    first_excluded = None
    pats = [re.compile(r'^(?:[A-Z\d]+(?:\.\d+)*\.?\s+)?' + re.escape(h) + r's?\s*$', re.I) for h in p.get('excluded', ['References'])]
    for pg in pages:
        if any(pt_.match(l) for pt_ in pats for l in pg['lines']):
            first_excluded = pg
            break
    body_pages = (first_excluded['page'] - 1 if first_excluded else len(pages))
    if first_excluded:
        idx = next(i for i, l in enumerate(first_excluded['lines']) if any(pt_.match(l) for pt_ in pats))
        if idx > 3:   # the excluded section starts below some body text on that page
            body_pages = first_excluded['page']
    if body_pages > p['max_pages']:
        return [finding(rule['id'], 'error', f'p.{p["max_pages"] + 1}', f'正文约 {body_pages} 页，超过 {p["max_pages"]} 页上限（参考文献等不计入）', str(body_pages))]
    return []


@check('citation_grouping')
def _citation_grouping(doc: Doc, p: dict, rule: dict) -> list:
    """Numeric in-text citation format. optica: [2,3] and [1–4] for ≥3 consecutive.
    ieee: each number in its own brackets, no ranges: [1], [2], [3]."""
    text = _plain(doc)
    stop = _ref_section_start(doc)
    if stop:
        text = text[:stop]
    out = []
    style = p['style']
    pat = r'\[(\d+(?:\s*[-–,，]\s*\d+)+)\]|\[\d+\]\s*[-–]\s*\[\d+\]' + (r'|\[\d+\](?:\s*\[\d+\])+' if style == 'gbt7714' else '')
    for m in re.finditer(pat, text):
        s = m.group(0)
        if style == 'gbt7714':
            if re.search(r'\]\s*\[', s):
                out.append(finding(rule['id'], 'warning', doc.loc(m.start()), f'同一处引用多篇文献时，序号全部列在一个方括号里，用「,」分隔：{s}', s))
            elif m.group(1):
                nums = _expand_numbers(m.group(1))
                if len(nums) >= 3 and nums == list(range(nums[0], nums[0] + len(nums))) and re.search(r'[,，]', m.group(1)):
                    out.append(finding(rule['id'], 'info', doc.loc(m.start()), f'连续序号用短横线连接起讫序号：{s} → [{nums[0]}-{nums[-1]}]', s))
        elif style == 'ieee':
            out.append(finding(rule['id'], 'warning', doc.loc(m.start()), f'IEEE 引用每个编号单独加方括号、不写范围：{s} → ' + ', '.join(f'[{n}]' for n in _expand_numbers(re.sub(r'[\[\]]', '', s.replace('][', ',').replace(']–[', '–').replace(']-[', '-')))), s))
        elif style == 'optica':
            nums = _expand_numbers(m.group(1)) if m.group(1) else []
            if re.search(r'\]\s*[-–]\s*\[', s):
                out.append(finding(rule['id'], 'warning', doc.loc(m.start()), f'Optica 引用范围写在同一个方括号里：{s} → [a–b]', s))
            elif len(nums) >= 3 and nums == list(range(nums[0], nums[0] + len(nums))) and ',' in m.group(1).replace('，', ','):
                out.append(finding(rule['id'], 'info', doc.loc(m.start()), f'三个及以上连续编号用短横线：{s} → [{nums[0]}–{nums[-1]}]', s))
        if len(out) >= p.get('max', 15):
            break
    return out


@check('title_terms')
def _title_terms(doc: Doc, p: dict, rule: dict) -> list:
    title = doc.meta.get('title')
    if not title:
        return []
    out = []
    words = re.findall(r"[A-Za-z]+", title)
    if p.get('avoid_start') and words and words[0].lower() in [w.lower() for w in p['avoid_start']]:
        out.append(finding(rule['id'] + '.start', 'warning', doc.meta.get('title_loc', ''), f'题名不要以「{words[0]}」开头', title[:60]))
    for w in p.get('avoid_words', []):
        if re.search(r'\b' + re.escape(w) + r'\b', title, re.I):
            out.append(finding(rule['id'] + '.word', 'warning', doc.meta.get('title_loc', ''), f'题名避免使用「{w}」', title[:60]))
    return out


@check('abstract_content')
def _abstract_content(doc: Doc, p: dict, rule: dict) -> list:
    """Abstract self-contained: no citations / equations (IEEE); 'first/new/novel' must be qualified (Optica)."""
    raw = doc.meta.get('abstract_en') or doc.meta.get('abstract') or ''
    out = []
    loc = doc.meta.get('abstract_en_loc') or doc.meta.get('abstract_loc', '')
    if doc.kind == 'latex':
        m = re.search(r'\\begin\{abstract\}(.*?)\\end\{abstract\}', doc.text, re.S)
        raw_tex = m.group(1) if m else ''
    else:
        raw_tex = raw
    if p.get('no_citations') and (re.search(r'\\cite', raw_tex) or _NUMCITE.search(raw)):
        out.append(finding(rule['id'] + '.citation', 'warning', loc, '摘要应自成一体，不要引用文献编号'))
    if p.get('no_math') and re.search(r'\$[^$]+\$|\\\(|\\\[', raw_tex):
        out.append(finding(rule['id'] + '.math', 'warning', loc, '摘要里不要放数学公式 / 符号（可能无法正确显示）'))
    for w in p.get('qualify_words', []):
        for m in re.finditer(r'\b' + re.escape(w) + r'\b', raw, re.I):
            ctx = raw[max(0, m.start() - 40): m.end() + 20]
            if not re.search(r'to (our|the best of our) knowledge|believed to be|new to our knowledge', ctx, re.I):
                out.append(finding(rule['id'] + '.claim', 'info', loc, f'摘要中的「{w}」需要限定，如 “believed to be first” 或 “new to our knowledge”', ctx.strip()))
    return out


@check('xref_style')
def _xref_style(doc: Doc, p: dict, rule: dict) -> list:
    """Optica: identify equations and figures in the text as 'Eq. (1)' and 'Fig. 1'."""
    text = _plain(doc) if doc.kind != 'latex' else doc.text
    stop = _ref_section_start(doc)
    if stop:
        text = text[:stop]
    out = []
    for m in re.finditer(r'(?<![.\n])\s(Figure|figure)\s*~?\s*(\\ref\{[^}]+\}|\d+)', text):
        out.append(finding(rule['id'] + '.figure', 'info', doc.loc(m.start()), f'正文中图的引用写作 “Fig. {m.group(2)}”', m.group(0).strip()))
    for m in re.finditer(r'\b(equation|Equation)\s*~?\s*(\(?\\(?:eq)?ref\{[^}]+\}\)?|\(\d+\))', text):
        out.append(finding(rule['id'] + '.equation', 'info', doc.loc(m.start()), '正文中公式的引用写作 “Eq. (1)”', m.group(0).strip()))
    return out[: p.get('max', 15)]


@check('pattern')
def _pattern(doc: Doc, p: dict, rule: dict) -> list:
    """Generic user rule: phrases or a regex in the body (or abstract / captions), with a custom message.
    Quoted counter-examples (「不可写成…」) and the reference list are skipped."""
    scope = p.get('scope', 'all')
    if scope == 'abstract':
        text = doc.meta.get('abstract', '')
    elif scope == 'captions':
        text = '\n'.join(f.get('caption') or '' for f in doc.floats)
    else:
        text = _plain(doc)
        stop = _ref_section_start(doc)
        if stop:
            text = text[:stop]
    pats = [re.escape(x) for x in p.get('phrases', []) or []]
    if p.get('regex'):
        pats.append(p['regex'])
    out = []
    msg = p.get('message') or '命中自定义规则'
    for pat in pats:
        try:
            rx = re.compile(pat)
        except re.error as e:
            return [finding(rule['id'], 'info', '', f'规则的正则表达式无效：{e}')]
        hits = [m for m in rx.finditer(text) if not _counterexample(text, m.start())]
        for m in hits[: int(p.get('max_hits', 5))]:
            loc = doc.meta.get('abstract_loc', '') if scope == 'abstract' else ('图表标题' if scope == 'captions' else doc.loc(m.start()))
            out.append(finding(rule['id'], p.get('severity', 'warning'), loc, msg, m.group(0)))
    return out


@check('avoid_phrases')
def _avoid_phrases(doc: Doc, p: dict, rule: dict) -> list:
    scope = p.get('scope', 'all')
    text = (doc.meta.get('abstract', '') if scope == 'abstract' else _plain(doc))
    stop = _ref_section_start(doc) if scope != 'abstract' else None
    if stop:
        text = text[:stop]
    out = []
    for ph in p.get('phrases', []):
        hits = [m.start() for m in re.finditer(re.escape(ph), text)]
        if hits:
            loc = doc.meta.get('abstract_loc', '') if scope == 'abstract' else doc.loc(hits[0])
            out.append(finding(rule['id'], 'info', loc, f'{"摘要" if scope == "abstract" else "全文"}出现「{ph}」{len(hits)} 次，建议改用客观表述', ph))
    return out


# ============================================================ rule packs

def list_packs() -> list[str]:
    return sorted(p.stem for p in RULES_DIR.glob('*.yaml'))


def user_pack_file() -> Path | None:
    """The user's own rules live in the data directory (never in the repo): $EVOSCHOLAR_DATA/rulepacks/user.yaml."""
    import os
    d = os.environ.get('EVOSCHOLAR_DATA')
    return Path(d) / 'rulepacks' / 'user.yaml' if d else None


def load_pack(name: str) -> dict:
    if not re.fullmatch(r'[a-z0-9-]+', name):
        raise ValueError(f'无效的规则包名：{name}')
    if name == 'user' and user_pack_file() is not None:
        import yaml
        uf = user_pack_file()
        pack = (yaml.safe_load(uf.read_text(encoding='utf-8')) if uf.exists() else None) or {}
        pack.setdefault('id', 'user')
        pack.setdefault('name', '我的规则')
        rules = []
        for r in pack.get('rules') or []:
            if r.get('status') == 'disabled':
                continue
            if r.get('status') == 'trial':  # proposals run as hints until the user accepts them
                r = {**r, 'params': {**(r.get('params') or {}), 'severity': 'info', 'message': '[试用规则] ' + str((r.get('params') or {}).get('message', ''))}}
            rules.append(r)
        pack['rules'] = rules
        return pack
    f = RULES_DIR / f'{name}.yaml'
    if not f.exists():
        raise ValueError(f'没有规则包 {name}；可用：{", ".join(list_packs())}')
    import yaml
    pack = yaml.safe_load(f.read_text(encoding='utf-8')) or {}
    pack.setdefault('id', name)
    return pack


def resolve_packs(names: Iterable[str]) -> list[dict]:
    out, seen = [], set()

    def add(n):
        if n in seen:
            return
        seen.add(n)
        pack = load_pack(n)
        for parent in pack.get('extends', []) or []:
            add(parent)
        out.append(pack)
    for n in names:
        add(n)
    return out


def _source_label(pack: dict, sid: str | None) -> str:
    for s in pack.get('sources', []) or []:
        if s.get('id') == sid:
            where = s.get('url') or s.get('file')
            return f'{s.get("title", sid)}（{where + "，" if where else ""}核对于 {s.get("checked", "?")}）'
    return sid or ''


PDF_CHECKS = {'page_limit', 'anonymity', 'required_sections', 'section_order'}
STAGES = ('submission', 'camera-ready')


def run(path: str | Path, packs: Iterable[str] = ('common',), variant: str | None = None, doc: Doc | None = None, stage: str = 'submission') -> dict:
    """Run every rule of the given packs (and the packs they extend) on a manuscript.
    stage: 'submission' (default) or 'camera-ready' (rules may skip or relax themselves per stage)."""
    if stage not in STAGES:
        raise ValueError(f'stage 只能是 {" / ".join(STAGES)}')
    doc = doc or load(path)
    packs = list(packs)
    uf = user_pack_file()
    if uf is not None and uf.exists() and 'user' not in packs:
        packs.append('user')
    resolved = resolve_packs(packs)
    findings: list[dict] = []
    verify: list[str] = []
    skipped = []
    replaced = {r['replaces'] for pk in resolved for r in (pk.get('rules') or []) if r.get('replaces')}
    for pack in resolved:
        variants = pack.get('variants') or {}
        eff = None
        if variants:
            if variant and variant not in variants:
                raise ValueError(f'规则包 {pack["id"]} 没有类型 {variant}；可选：{", ".join(variants)}')
            eff = variant or next(iter(variants))
            if not variant:
                verify.append(f'[{pack["id"]}] 未指定类型，按「{variants[eff]}」检查；可选：{", ".join(variants)}')
        for item in pack.get('verify', []) or []:
            verify.append(f'[{pack["id"]}] {item}')
        for rule in pack.get('rules', []) or []:
            if rule['id'] in replaced:
                continue
            applies = rule.get('applies')
            if applies and eff not in applies:
                continue
            fn = CHECKS.get(rule['check'])
            if fn is None:
                skipped.append(rule['id'])
                continue
            if doc.kind == 'pdf' and rule['check'] not in PDF_CHECKS:
                continue
            if stage in (rule.get('skip_stages') or []):
                continue
            params = dict(rule.get('params') or {})
            params.update((rule.get('params_by_stage') or {}).get(stage, {}))
            pv = (rule.get('params_by_variant') or {})
            if pv:
                if eff not in pv:
                    continue
                params.update(pv[eff])
            try:
                got = fn(doc, params, rule)
            except Exception as e:  # a broken check must not hide the others
                got = [finding(rule['id'], 'info', '', f'检查出错：{type(e).__name__}: {e}')]
            src = _source_label(pack, rule.get('source'))
            for f in got:
                f['source'] = src
                if rule.get('severity') and f['severity'] != 'info' and f['severity'] != 'error':
                    f['severity'] = rule['severity']
                f['pack'] = pack['id']
                findings.append(f)
    order = {'error': 0, 'warning': 1, 'info': 2}
    findings.sort(key=lambda f: (order.get(f['severity'], 3)))
    for k, f in enumerate(findings, 1):
        f['id'] = f'F{k:03d}'
    summary = {
        'file': doc.path.name, 'kind': doc.kind, 'packs': [p['id'] for p in resolved], 'variant': variant or next((next(iter(p['variants'])) for p in resolved if p.get('variants')), None),
        'files': doc.files, 'unreached_tex': doc.unreached, 'sections': len(doc.sections), 'citations': sum(len(c['keys']) for c in doc.cites),
        'references': len(doc.bib), 'figures': sum(1 for f in doc.floats if f['kind'] == 'figure'), 'tables': sum(1 for f in doc.floats if f['kind'] == 'table'),
        'notes': doc.notes + (['PDF 只做页数、元数据和章节检查；正文内容检查请对源文件（.tex / .docx）运行'] if doc.kind == 'pdf' else []),
        'stage': stage,
    }
    return {'summary': summary, 'findings': findings, 'verify': verify, 'skipped_rules': skipped,
            'counts': {s: sum(1 for f in findings if f['severity'] == s) for s in ('error', 'warning', 'info')}}


def format_report(rep: dict, max_items: int = 80) -> str:
    s = rep['summary']
    c = rep['counts']
    lines = [f'# 稿件检查报告：{s["file"]}',
             f'规则包：{", ".join(s["packs"])}{"（" + s["variant"] + "）" if s.get("variant") else ""}{" · 终稿" if s.get("stage") == "camera-ready" else ""} · 错误 {c["error"]} · 提醒 {c["warning"]} · 提示 {c["info"]}',
             f'结构：{s["sections"]} 个标题，{s["figures"]} 图，{s["tables"]} 表，{s["references"]} 条参考文献，{s["citations"]} 次引用']
    if s.get('files') and len(s['files']) > 1:
        lines.append(f'参与编译的文件：{", ".join(s["files"])}')
    if s.get('unreached_tex'):
        lines.append(f'未被主文件引入（不检查）：{", ".join(s["unreached_tex"])}')
    for n in s.get('notes', []):
        lines.append(f'注意：{n}')
    label = {'error': '错误', 'warning': '提醒', 'info': '提示'}
    for f in rep['findings'][:max_items]:
        lines.append(f'- {f["id"]} [{label[f["severity"]]}] {f["loc"] or "全文"} · {f["message"]}' + (f'  ⟨{f["evidence"]}⟩' if f.get('evidence') and f['evidence'] not in f['message'] else ''))
    if len(rep['findings']) > max_items:
        lines.append(f'…… 另有 {len(rep["findings"]) - max_items} 条，见 JSON 报告')
    if rep.get('verify'):
        lines.append('\n## 请核对目标期刊 / 学校的最新要求（规则包未能核实，未自动检查）')
        lines += [f'- {v}' for v in rep['verify']]
    srcs = sorted({f['source'] for f in rep['findings'] if f.get('source')})
    if srcs:
        lines.append('\n## 依据')
        lines += [f'- {x}' for x in srcs]
    return '\n'.join(lines)


# ============================================================ write-back

def annotate(rep: dict, src: str | Path, out_dir: str | Path) -> list[str]:
    """Write annotated copies (originals are never modified).
    LaTeX: each flagged line gets a trailing '% EVO[Fxxx]: …' comment.  Word: comments on flagged paragraphs."""
    src = Path(src)
    out = Path(out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    written = []
    by_loc: dict[str, list[dict]] = {}
    for f in rep['findings']:
        if f['loc']:
            by_loc.setdefault(f['loc'], []).append(f)
    if src.suffix.lower() == '.tex':
        root = src.resolve().parent
        for rel in rep['summary']['files']:
            source = _contained_path(root, root / rel)
            if source is None or not source.is_file():
                continue
            lines = source.read_text(encoding='utf-8', errors='replace').splitlines()
            changed = False
            for n in range(len(lines)):
                fs = by_loc.get(f'{rel}:{n + 1}')
                if fs:
                    lines[n] += '  % EVO' + ' '.join(f'[{f["id"]}] {f["message"]}' for f in fs).replace('\n', ' ')
                    changed = True
            if changed:
                target = _output_path(out, out / rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('\n'.join(lines) + '\n', encoding='utf-8')
                written.append(str(target))
    elif src.suffix.lower() == '.docx':
        import docx
        d = docx.Document(str(src))
        paras = d.paragraphs
        general = []
        for loc, fs in by_loc.items():
            m = re.fullmatch(r'段落 (\d+)', loc)
            text = '；'.join(f'[{f["id"]}] {f["message"]}' for f in fs)
            if m and 0 < int(m.group(1)) <= len(paras) and paras[int(m.group(1)) - 1].runs:
                p = paras[int(m.group(1)) - 1]
                d.add_comment(p.runs, text=text, author='EvoScholar', initials='ES')
            else:
                general.append(text)
        target = _output_path(out, out / (src.stem + '.checked.docx'))
        d.save(str(target))
        written.append(str(target))
    return written


# ============================================================ CLI

def _cli(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog='evoscholar_write')
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('check')
    c.add_argument('file')
    c.add_argument('--pack', action='append', default=[])
    c.add_argument('--variant')
    c.add_argument('--out')
    c.add_argument('--annotate', action='store_true')
    c.add_argument('--stage', default='submission', choices=STAGES)
    sub.add_parser('packs')
    a = ap.parse_args(argv)
    if a.cmd == 'packs':
        print(json.dumps([{'id': n, 'name': load_pack(n).get('name'), 'variants': list((load_pack(n).get('variants') or {}).keys()),
                           'rules': len(load_pack(n).get('rules') or []), 'verify': len(load_pack(n).get('verify') or [])} for n in list_packs()], ensure_ascii=False))
        return 0
    rep = run(a.file, a.pack or ['common'], a.variant, stage=a.stage)
    if a.out:
        out = Path(a.out).resolve()
        out.mkdir(parents=True, exist_ok=True)
        _output_path(out, out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding='utf-8')
        _output_path(out, out / 'report.md').write_text(format_report(rep, max_items=1000), encoding='utf-8')
        rep['written'] = [str(out / 'report.json'), str(out / 'report.md')]
        if a.annotate:
            rep['written'] += annotate(rep, a.file, _output_path(out, out / 'annotated'))
    rep['text'] = format_report(rep)
    print(json.dumps(rep, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    for _s in (sys.stdout, sys.stderr):  # Windows consoles default to a legacy code page; output is UTF-8 JSON / Chinese
        try:
            _s.reconfigure(encoding='utf-8')
        except Exception:
            pass
    sys.exit(_cli(sys.argv[1:]))
