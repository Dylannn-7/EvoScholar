import os
import tempfile
import unittest

import evoscholar_styles as S


class StyleCatalogTest(unittest.TestCase):
    def test_catalog_covers_four_libraries(self):
        libs = {s['library'] for s in S.list_styles()}
        self.assertTrue({'SciencePlots', 'tueplots', 'aquarel', 'cmcrameri', 'EvoScholar'} <= libs)
        for s in S.list_styles():
            self.assertTrue(s['license'])

    def test_style_then_venue_keeps_colours_and_venue_fonts(self):
        import matplotlib as mpl
        S.use('sp-bright')
        bright = mpl.rcParams['axes.prop_cycle']
        info = S.use('sp-bright', venue='nature')
        self.assertEqual(mpl.rcParams['axes.prop_cycle'], bright)
        self.assertLessEqual(mpl.rcParams['font.size'], 7.0)
        self.assertEqual(info['venue'], 'nature')

    def test_meta_separates_look_alike_styles(self):
        a, b = S.style_meta('sp-science'), S.style_meta('sp-nature')
        self.assertEqual(a['colors'], b['colors'])
        self.assertNotEqual((a['font_pt'], a['width_in']), (b['font_pt'], b['width_in']), 'same palette, different size facts')
        self.assertTrue(S.style_meta('sp-ieee')['linestyles'])
        self.assertTrue(S.style_meta('sp-grid')['grid'])
        self.assertEqual(S.style_meta('cmc-vik')['cmap'], 'vik')

    def test_unknown_style_lists_choices(self):
        with self.assertRaises(ValueError):
            S.use('nope')

    def test_preview_renders_every_kind(self):
        with tempfile.TemporaryDirectory() as d:
            for sid in ('evo-default', 'sp-ieee', 'tp-neurips2024', 'aq-scientific', 'cmc-vik', 'sp-cjk'):
                out = os.path.join(d, f'{sid}.png')
                S.preview(sid, out)
                self.assertGreater(os.path.getsize(out), 5000, sid)


if __name__ == '__main__':
    unittest.main()
