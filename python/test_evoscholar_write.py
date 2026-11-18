import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import evoscholar_write as Wr


def rules(rep):
    return [f['rule'] for f in rep['findings']]


def by_rule(rep, prefix):
    return [f for f in rep['findings'] if f['rule'].startswith(prefix)]


class LatexProject(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        (self.d / 'sections').mkdir()
        (self.d / 'figs').mkdir()
        (self.d / 'figs' / 'ok.pdf').write_bytes(b'%PDF-1.4\n')
        (self.d / 'main.tex').write_text(r'''\documentclass{article}
\usepackage[final]{neurips_2025}
\graphicspath{{figs/}}
\title{A Study of Ring Modulators}
\author{Zhang San \\ HUST}
\begin{document}
\maketitle
\begin{abstract}
We show a 10nm linewidth \cite{a}.
\end{abstract}
% \input{sections/commented}
\input{sections/methods}
\input{sections/results.tex}
\section*{Acknowledgments}
Thanks.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
''', encoding='utf-8')
        (self.d / 'sections' / 'methods.tex').write_text(r'''\section{Methods}\label{sec:m}
The MZI is great. A Mach-Zehnder interferometer (MZI) is used, see Fig.~\ref{fig:a}.
\begin{figure}\includegraphics{ok}\caption{Setup}\label{fig:a}\end{figure}
\begin{figure}\includegraphics{missing}\caption{Gone}\label{fig:b}\end{figure}
In our previous work \cite{b,zz} we did it.
''', encoding='utf-8')
        (self.d / 'sections' / 'results.tex').write_text(r'''\section{Results}\label{sec:m}
See Section~\ref{sec:nope} and Eq.~\eqref{eq:1}.
\begin{equation}x=1\label{eq:1}\end{equation}
''', encoding='utf-8')
        (self.d / 'old_draft.tex').write_text(r'\label{sec:m}\ref{ghost}', encoding='utf-8')
        (self.d / 'refs.bib').write_text('@article{a,\n  title={A},\n  author={X, Y},\n  year={2020}\n}\n@article{b,\n  title={B},\n  author={Q, R},\n  year={2021}\n}\n@article{c,\n  title={C},\n  year={2022}\n}\n', encoding='utf-8')

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_structure_and_locations(self):
        doc = Wr.load(self.d / 'main.tex')
        self.assertEqual(doc.files, ['main.tex', 'sections/methods.tex', 'sections/results.tex'])
        self.assertEqual(doc.unreached, ['old_draft.tex'])
        rep = Wr.run(self.d / 'main.tex', ['common'])
        dup = by_rule(rep, 'common.xref.duplicate_label')
        self.assertEqual([(f['loc'], f['evidence']) for f in dup], [('sections/results.tex:1', 'sec:m')])
        self.assertEqual([f['loc'] for f in by_rule(rep, 'common.xref.unresolved_ref')], ['sections/results.tex:2'])
        self.assertEqual([f['evidence'] for f in by_rule(rep, 'common.xref.missing_figure')], ['missing'])
        self.assertEqual([f['evidence'] for f in by_rule(rep, 'common.citations.undefined')], ['zz'])
        self.assertEqual([f['evidence'] for f in by_rule(rep, 'common.citations.uncited')], ['c'])
        self.assertEqual([f['loc'] for f in by_rule(rep, 'common.units')], ['main.tex:9'])
        before = by_rule(rep, 'common.abbreviations.before_definition')
        self.assertEqual([(f['evidence'], f['loc']) for f in before], [('MZI', 'sections/methods.tex:2')])
        self.assertIn('fig:b', [f['evidence'] for f in by_rule(rep, 'common.floats.unreferenced')])

    def test_ml_conference_anonymity(self):
        rep = Wr.run(self.d / 'main.tex', ['ml-conference'], 'neurips2025')
        got = rules(rep)
        for r in ('ml.anonymity.mode', 'ml.anonymity.author_byline', 'ml.anonymity.acknowledgment', 'ml.anonymity.self_reference', 'ml.checklist.neurips'):
            self.assertIn(r, got)
        self.assertTrue(any('PDF' in f['message'] for f in by_rule(rep, 'ml.pages')))   # page limit needs the PDF
        self.assertTrue(all(f['source'] for f in rep['findings']))

    def test_annotate_latex(self):
        rep = Wr.run(self.d / 'main.tex', ['common'])
        out = Wr.annotate(rep, self.d / 'main.tex', self.d / 'out')
        txt = (self.d / 'out' / 'sections' / 'results.tex').read_text(encoding='utf-8')
        self.assertIn('% EVO[', txt)
        self.assertIn('sec:m', (self.d / 'sections' / 'results.tex').read_text(encoding='utf-8'))   # original untouched
        self.assertTrue(any(p.endswith('results.tex') for p in out))


class WordThesis(unittest.TestCase):
    def setUp(self):
        import docx
        from docx.shared import Pt
        from PIL import Image
        self.d = Path(tempfile.mkdtemp())
        Image.new('RGB', (20, 20), 'white').save(self.d / 'x.png')
        d = docx.Document()
        d.add_heading('摘  要', level=1)
        d.add_paragraph('本文研究了微环调制器。' * 10)
        d.add_paragraph('关键词：微环；调制器')
        d.add_heading('Abstract', level=1)
        d.add_paragraph('This thesis studies ring modulators.')
        d.add_paragraph('Key words: ring; modulator; silicon')
        d.add_heading('1 绪论', level=1)
        d.add_heading('1.1 研究背景', level=2)
        p = d.add_paragraph('我们的结果见文献[1]和[3]，以及[2]，效率提升15～20%，器件长度为 3,800,000 nm。见图1-1和表1-1。')
        for r in p.runs:
            r.font.size = Pt(10.5)
        d.add_paragraph('图1-1  器件结构')
        d.add_picture(str(self.d / 'x.png'))
        d.add_paragraph('表1-1  参数')
        d.add_table(rows=2, cols=2)
        d.add_heading('参考文献', level=1)
        d.add_paragraph('[1] 张三, 李四. 一篇文章. 光学学报, 2020, 40(1): 1-5')
        d.add_paragraph('[2] A. B, C. D, E. F, G. H, I. J, K. L, M. N. Long author list. Optica, 2021, 8(1): 1-9.')
        d.add_paragraph('[3] X. Y. Paper three. Nature, 2019, 1: 1-2')
        d.add_heading('致  谢', level=1)
        d.add_paragraph('感谢。')
        self.path = self.d / 'thesis.docx'
        d.save(self.path)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_hust_master(self):
        rep = Wr.run(self.path, ['hust-thesis'], 'master')
        got = rules(rep)
        self.assertEqual(rep['summary']['variant'], 'master')
        self.assertIn('hust.abstract.zh', got)                    # 100 characters < 500
        self.assertIn('hust.keywords.zh.count', got)              # 2 keywords
        self.assertIn('hust.citation.order', got)                 # [3] cited before [2]
        self.assertIn('hust.numbers.range.percent', got)
        self.assertIn('hust.numbers.range.thousands', got)
        self.assertIn('hust.abstract.we', got)
        self.assertIn('hust.sections.order', got)                 # 参考文献 before 致谢
        self.assertIn('hust.references.stats.total', got)
        fmt = by_rule(rep, 'hust.references.format')
        self.assertEqual(len(fmt), 1)                             # [2]: 7 authors, trailing period
        self.assertIn('不加标点', fmt[0]['message'])
        self.assertIn('6', fmt[0]['message'])
        fonts = by_rule(rep, 'hust.docx.fonts.body')
        self.assertTrue(any('10.5' in f['message'] for f in fonts))
        self.assertNotIn('common.floats', ' '.join(got))          # replaced by hust.floats.numbering
        self.assertTrue(any('作者数' in v for v in rep['verify']))
        self.assertTrue(all(f['source'] for f in rep['findings'] if f['pack'] == 'hust-thesis'))

    def test_undergrad_captions_and_annotate(self):
        rep = Wr.run(self.path, ['hust-thesis'], 'undergrad')
        cap = by_rule(rep, 'hust.floats.caption_position')
        self.assertEqual(len(cap), 1)                             # figure caption above the picture
        self.assertIn('图', cap[0]['message'])
        self.assertIn('hust.keywords.zh.count', rules(rep))       # undergrad: 3–5
        out = Wr.annotate(rep, self.path, self.d / 'out')
        self.assertTrue(Path(out[0]).exists())
        import docx
        self.assertGreater(len(list(docx.Document(out[0]).comments)), 0)

    def test_false_positive_guards(self):
        import docx
        from docx.shared import Pt
        d = docx.Document()
        cover = d.add_heading('硕士学位论文封面标题', level=1)       # cover page: not checked for fonts
        d.add_heading('摘  要', level=1)
        d.add_paragraph('百分数范围不可写成15～20%。文件 Word 自定义.exported 已导出。XXX 方法与 XXX 系统。')
        d.add_heading('参考文献', level=1)
        d.add_paragraph('参考文献格式说明：作者. 题名. 刊名, 年, 卷(期): 页码')   # instructions, not an entry
        d.add_paragraph('[1] 张三, 李四. 题名. 光学学报, 2020, 40(1): 1-5')
        d.add_heading('致  谢', level=1)
        path = self.d / 'fp.docx'
        d.save(path)
        rep = Wr.run(path, ['hust-thesis'], 'master')
        got = rules(rep)
        self.assertNotIn('hust.numbers.range.percent', got)            # quoted wrong example
        self.assertNotIn('common.punctuation.half_in_zh', got)         # file extension
        self.assertNotIn('common.abbreviations.undefined', got)        # placeholder XXX
        self.assertEqual(rep['summary']['references'], 1)              # instruction paragraph dropped
        self.assertFalse([f for f in by_rule(rep, 'hust.docx.fonts') if f['loc'] == '段落 1'])

    def test_variant_validation(self):
        self.assertRaises(ValueError, Wr.run, self.path, ['hust-thesis'], 'bachelor')
        self.assertRaises(ValueError, Wr.load_pack, '../x')


class TextAndPdf(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_citation_styles_and_reference_formats(self):
        md = self.d / 'p.md'
        md.write_text('# Intro\nPrior work [1,2,3] and [4]–[5] shows a novel effect, see Figure 2 and equation (1).\n\n'
                      '# References\n[1] A. One, B. Two, C. Three, and D. Four, Appl. Opt. 31, 1-2 (1992).\n'
                      '[2] Smith, J. A paper. Journal, 2020.\n[3] x\n[4] y\n[5] z\n', encoding='utf-8')
        opt = Wr.run(md, ['optica'])
        self.assertIn('optica.citation.grouping', rules(opt))
        self.assertTrue(any('3 个' in f['message'] for f in by_rule(opt, 'optica.references.format')))
        self.assertIn('optica.xref.figure', rules(opt))
        self.assertIn('optica.xref.equation', rules(opt))
        ieee = Wr.run(md, ['ieee-journal'])
        g = by_rule(ieee, 'ieee.citation.grouping')
        self.assertEqual(len(g), 2)
        self.assertIn('[1], [2], [3]', g[0]['message'])
        self.assertTrue(any('引号' in f['message'] for f in by_rule(ieee, 'ieee.references.format')))
        self.assertTrue(any('姓, 名' in f['message'] for f in by_rule(ieee, 'ieee.references.format')))

    def test_gbt7714_2025(self):
        md = self.d / 'g.md'
        md.write_text('# 绪论\n已有研究[1][2]表明，见[3,4,5]。\n\n# 参考文献\n'
                      '[1] 杨宗英. 电子图书馆的现实模型[J]. 中国图书馆学报, 1996(2): 24-29.\n'
                      '[2] 钱学森, 刘再复, 李四光, 华罗庚. 一本书[M]. 北京: 科学出版社, 2013\n'
                      '[3] Sunstein C R. Social norms[J]. Columbia Law Review, 1996, 96: 903. http://example.org/x\n'
                      '[4] A. Einstein, B. Podolsky. Completeness[J]. Phys Rev, 1935, 47: 777\n'
                      '[5] Jenkins S D, Ruostekoski J. Light[PP/OL]. V2. (2012-03-18)[2020-06-24]. https://doi.org/10.48550/arXiv.1112.6136.\n',
                      encoding='utf-8')
        rep = Wr.run(md, ['gbt7714'])
        fmt = {f['loc']: f['message'] for f in by_rule(rep, 'gbt7714.references.format')}
        self.assertEqual(set(fmt), {'g.md:6', 'g.md:7', 'g.md:8'})     # [1] and the 2025-style preprint [5] are fine
        self.assertIn('7.1.2', fmt['g.md:6'])
        self.assertIn('[J/OL]', fmt['g.md:7'])
        self.assertIn('7.1.1', fmt['g.md:8'])
        self.assertEqual(len(by_rule(rep, 'gbt7714.citation.grouping')), 2)
        self.assertTrue(any('PP' in v for v in rep['verify']))

    def test_pdf_page_limit_and_metadata(self):
        try:
            import pymupdf as fitz
        except ImportError:
            import fitz
        pdf = fitz.open()
        for i in range(1, 13):
            page = pdf.new_page()
            page.insert_text((72, 72), 'References' if i == 11 else f'{i} Section text', fontsize=12)
            page.insert_text((72, 100), 'body line ' * 5, fontsize=10)
        pdf.set_metadata({'author': 'Zhang San'})
        path = self.d / 'paper.pdf'
        pdf.save(path)
        rep = Wr.run(path, ['ml-conference'], 'neurips2026')
        lim = by_rule(rep, 'ml.pages.neurips2026')
        self.assertEqual(len(lim), 1)
        self.assertIn('10 页', lim[0]['message'])
        self.assertIn('ml.anonymity.pdf_author', rules(rep))
        self.assertEqual(Wr.pdf_section_pages(path, ['References'])['starts'], {'References': 11})
        ok = Wr.run(path, ['ml-conference'], 'iclr2026')
        self.assertTrue(by_rule(ok, 'ml.pages.iclr2026'))      # 10 > 9 as well

    def test_cli(self):
        out = subprocess.run([sys.executable, Wr.__file__, 'packs'], capture_output=True, text=True, check=True).stdout
        packs = {p['id']: p for p in json.loads(out)}
        for must in ('hust-thesis', 'gbt7714', 'optica', 'ieee-journal', 'ml-conference', 'common'):
            self.assertIn(must, packs)
        self.assertEqual(packs['hust-thesis']['variants'], ['master', 'doctor', 'undergrad'])
        md = self.d / 'a.md'
        md.write_text('# 摘要\n这是一段中文,用了半角逗号。\n', encoding='utf-8')
        r = json.loads(subprocess.run([sys.executable, Wr.__file__, 'check', str(md), '--out', str(self.d / 'rep')], capture_output=True, text=True, check=True).stdout)
        self.assertIn('common.punctuation.half_in_zh', rules(r))
        self.assertTrue((self.d / 'rep' / 'report.md').exists())

    def test_every_rule_has_a_known_check_and_source(self):
        for name in Wr.list_packs():
            pack = Wr.load_pack(name)
            ids = {s['id'] for s in pack.get('sources') or []}
            for s in pack.get('sources') or []:
                self.assertTrue(s.get('url') or s.get('file') or s['id'] == 'internal', (name, s))
                self.assertTrue(str(s.get('checked', '')).startswith('2026'), (name, s))
            for r in pack.get('rules') or []:
                self.assertIn(r['check'], Wr.CHECKS, (name, r['id']))
                self.assertIn(r.get('source'), ids, (name, r['id']))
            if not pack.get('rules'):
                self.assertTrue(pack.get('verify'), name)            # unverified packs must say so


if __name__ == '__main__':
    unittest.main()
