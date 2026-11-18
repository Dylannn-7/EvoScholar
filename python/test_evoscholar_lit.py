import unittest
import evoscholar_lit as lit

class T(unittest.TestCase):
    def test_doi(self):
        self.assertEqual(lit.normalize_doi("https://doi.org/10.1364/OE.123456."), "10.1364/oe.123456")
        self.assertEqual(lit.normalize_doi("doi: 10.1109/JSTQE.2024.1"), "10.1109/jstqe.2024.1")
        self.assertIsNone(lit.normalize_doi("n/a"))
    def test_arxiv(self):
        self.assertEqual(lit.normalize_arxiv("arXiv:2401.01234v3"), "2401.01234")
        self.assertEqual(lit.normalize_arxiv("https://arxiv.org/pdf/2401.01234v2.pdf", keep_version=True), "2401.01234v2")
    def test_merge(self):
        recs = [
            {"id": "A1", "title": "Photonic Tensor Cores", "doi": "10.48550/arXiv.2401.01234", "arxiv": "2401.01234v1", "year": 2024, "authors": ["Lin, Y."]},
            {"id": "C1", "title": "Photonic tensor cores!", "doi": "10.1038/s41566-024-1", "year": 2025, "authors": ["Yu Lin"], "arxiv": "2401.01234"},
            {"id": "Z1", "title": "Something else", "doi": "https://doi.org/10.1038/S41566-024-1"},
            {"id": "X", "title": "Unrelated", "year": 2020},
        ]
        groups = {tuple(sorted(g["records"])): g for g in lit.merge_records(recs)}
        self.assertIn(("A1", "C1", "Z1"), groups)
        self.assertEqual(groups[("A1", "C1", "Z1")]["doi"], "10.1038/s41566-024-1")
        self.assertIn(("X",), groups)
    def test_importers(self):
        ris = "TY  - JOUR\nAU  - Li, Hua\nTI  - 光子神经网络\nJO  - 光学学报\nPY  - 2024\nDO  - 10.3788/AOS2024.1\nER  - \n"
        self.assertEqual(lit.parse_any(ris)[0], "ris")
        self.assertEqual(lit.parse_any(ris)[1][0]["doi"], "10.3788/aos2024.1")
        ne = "{Reference Type}: Journal Article\n{Title}: 硅基光子芯片\n{Author}: 张三;李四;\n{Journal}: 物理学报\n{Year}: 2023\n"
        f, r = lit.parse_any(ne)
        self.assertEqual((f, r[0]["authors"], r[0]["year"]), ("noteexpress", ["张三", "李四"], 2023))
        en = "%0 Journal Article\n%A 王五\n%T 片上光计算\n%J 中国激光\n%D 2025\n%R 10.3788/CJL2025.2\n"
        f, r = lit.parse_any(en)
        self.assertEqual((f, r[0]["venue"]), ("endnote", "中国激光"))
        g = "[1] 张三, 李四, 王五, 等. 基于微环的光学矩阵乘法[J]. 光学学报, 2024, 44(3): 0306001.\n[2] Lin Y, Zhang X. Photonic accelerators[J]. Nature Photonics, 2023, 17(2): 100-110."
        f, r = lit.parse_any(g)
        self.assertEqual(f, "gbt7714")
        self.assertEqual((r[0]["year"], r[0]["volume"], r[0]["issue"], r[0]["type"]), (2024, "44", "3", "journal"))
        self.assertEqual(r[1]["pages"], "100-110")
        bib = "@article{lin2023,\n  author = {Lin, Yu and Zhang, Xi},\n  title = {Photonic {AI}},\n  journal = {Nat. Photon.},\n  year = {2023},\n  doi = {10.1038/X}\n}\n"
        f, r = lit.parse_any(bib)
        self.assertEqual((f, r[0]["authors"], r[0]["title"]), ("bibtex", ["Lin, Yu", "Zhang, Xi"], "Photonic AI"))
    def test_hops(self):
        h = lit.citation_hops([("P1", "SEED"), ("P1", "SEED"), ("SEED", "R1"), ("P2", "SEED"), ("SEED", "SEED")], "SEED")
        self.assertEqual(h, {"forward": ["P1", "P2"], "backward": ["R1"]})

if __name__ == "__main__":
    unittest.main()
