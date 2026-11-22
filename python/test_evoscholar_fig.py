import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault('MPLBACKEND', 'Agg')
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

import evoscholar_data as D  # noqa: E402
import evoscholar_fig as F  # noqa: E402


class RulePacks(unittest.TestCase):
    def test_every_pack_has_sources_and_widths(self):
        venues = F.list_venues()
        for v in ('nature', 'ieee', 'optica', 'wiley', 'neurips', 'iclr', 'icml', 'cvpr'):
            self.assertIn(v, venues)
        for v in venues:
            r = F.load_rules(v)
            self.assertEqual(r['id'], v)
            self.assertTrue(r['sources'], v)
            for s in r['sources']:
                self.assertTrue(s['url'].startswith('https://'), v)
                self.assertTrue(str(s['checked']).startswith('2026'), v)
            self.assertTrue(r['width_mm'], v)

    def test_known_values(self):
        self.assertEqual(F.load_rules('nature')['width_mm'], {'single': 89, 'double': 183})
        self.assertEqual(F.load_rules('nature')['font']['min_pt'], 5)
        self.assertEqual(F.load_rules('ieee')['line_art_min_dpi'], 600)
        w, h = F.figsize('ieee', 'single', aspect=0.5)
        self.assertAlmostEqual(w, 3.5, places=3)
        self.assertAlmostEqual(h, 1.75, places=3)
        _, h = F.figsize('nature', 'double', aspect=2)       # capped at 170 mm
        self.assertAlmostEqual(h * 25.4, 170, places=3)
        self.assertRaises(ValueError, F.load_rules, '../evil')
        self.assertRaises(ValueError, F.figsize, 'neurips', 'double')


class FigureChecks(unittest.TestCase):
    def setUp(self):
        plt.rcdefaults()
        self.tmp = tempfile.mkdtemp()
        self.cwd = os.getcwd()
        os.chdir(self.tmp)

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)
        plt.close('all')

    def rules(self, issues):
        return {i['rule'] for i in issues}

    def test_bad_figure_is_flagged(self):
        fig, ax = plt.subplots(figsize=(8, 5))
        x = np.linspace(0, 1, 10)
        ax.plot(x, x, color='#D62728')
        ax.plot(x, x ** 2, color='#2CA02C')
        ax.grid(True)
        ax.set_xlabel('Wavelength')
        ax.tick_params(labelsize=4)
        r = F.check_figure(fig, 'nature')
        self.assertFalse(r['ok'])
        got = self.rules(r['issues'])
        for rule in ('width', 'font.min', 'axes.units', 'axes.label', 'axes.gridlines', 'color.cvd'):
            self.assertIn(rule, got)

    def test_styled_figure_passes_and_files_are_checked(self):
        F.apply_style('nature')
        fig, ax = plt.subplots(figsize=F.figsize('nature', 'single'))
        x = np.linspace(0, 1, 10)
        ax.plot(x, x, label='A')
        ax.plot(x, x ** 2, '--', label='B')
        ax.set_xlabel('Wavelength (nm)')
        ax.set_ylabel('Transmission (a.u.)')
        F.panel_labels(fig, venue='nature')
        r = F.save(fig, 'out/fig1', venue='nature', columns='single')
        self.assertTrue(r['ok'], F.format_report(r))
        self.assertIn('89 mm 栏宽下有效 DPI', F.format_report(r))
        self.assertEqual([i for i in r['issues'] if i['level'] == 'error'], [])
        pdf = next(f for f in r['files'] if f['path'].endswith('.pdf'))
        self.assertAlmostEqual(pdf['measured']['width_mm'], 89, delta=0.5)
        self.assertFalse(any('Type3' in f for f in pdf['measured']['fonts']))
        svg = next(f for f in r['files'] if f['path'].endswith('.svg'))
        self.assertGreater(svg['measured']['text_elements'], 0)
        self.assertTrue(Path(r['preview']).exists())

    def test_categorical_axis_needs_no_unit(self):
        F.apply_style('nature')
        fig, ax = plt.subplots(figsize=F.figsize('nature', 'single'))
        ax.boxplot([[1, 2, 3], [2, 3, 4]], tick_labels=['A', 'B'])
        ax.set_ylabel('Latency (ms)')
        r = F.check_figure(fig, 'nature')
        self.assertNotIn('axes.label', self.rules(r['issues']))
        self.assertNotIn('axes.units', self.rules(r['issues']))

    def test_training_epoch_needs_no_unit(self):
        F.apply_style('nature')
        fig, ax = plt.subplots(figsize=F.figsize('nature', 'single'))
        ax.plot([1, 2], [13.89, 94.81])
        ax.set(xlabel='Epoch', ylabel='Training accuracy (%)')
        self.assertNotIn('axes.units', self.rules(F.check_figure(fig, 'nature')['issues']))
        ax.set_xlabel('Training time')
        self.assertIn('axes.units', self.rules(F.check_figure(fig, 'nature')['issues']))

    def test_optica_color_only(self):
        fig, ax = plt.subplots(figsize=F.figsize('optica', 'single'))
        x = np.linspace(0, 1, 5)
        ax.plot(x, x)
        ax.plot(x, 2 * x)
        ax.set_xlabel('t (s)')
        ax.set_ylabel('v (m/s)')
        self.assertIn('color.only', self.rules(F.check_figure(fig, 'optica')['issues']))

    def test_raster_dpi(self):
        fig, ax = plt.subplots(figsize=F.figsize('ieee', 'single'))
        ax.plot([0, 1], [0, 1])
        fig.savefig('low.png', dpi=150)
        r = F.check_file('low.png', 'ieee')
        self.assertIn('dpi', self.rules(r['issues']))
        self.assertFalse(r['ok'])

    def test_target_column_uses_effective_dpi(self):
        from PIL import Image
        img = Image.new('RGB', (1200, 600))
        img.save('plain.png')
        img.save('tagged.png', dpi=(600, 600))

        missing = F.check_file('plain.png', 'ieee', line_art=False)
        self.assertEqual(missing['status'], 'review')
        self.assertTrue(F.format_report(missing).startswith('待核对'))

        single = F.check_file('plain.png', 'ieee', line_art=False, columns='single')
        self.assertEqual(single['status'], 'pass')
        self.assertEqual(single['measured']['target_width_mm'], 88.9)
        self.assertAlmostEqual(single['measured']['effective_dpi'], 342.86)

        double = F.check_file('tagged.png', 'ieee', line_art=False, columns='double')
        self.assertEqual(double['status'], 'fail')
        self.assertEqual(double['measured']['dpi'], 600)
        self.assertAlmostEqual(double['measured']['effective_dpi'], 167.47)

        unnamed = F.check_file('plain.png', 'wiley', line_art=False, columns='single')
        self.assertEqual(unnamed['status'], 'review')
        self.assertNotIn('effective_dpi', unnamed['measured'])
        custom = F.check_file('plain.png', 'wiley', line_art=False, target_width_mm=95)
        self.assertEqual(custom['status'], 'pass')
        self.assertAlmostEqual(custom['measured']['effective_dpi'], 320.84)
        self.assertEqual(F.check_file('plain.png')['status'], 'measured')

    def test_colorblind_palette(self):
        self.assertEqual(F.colorblind_conflicts(F.WONG[1:]), [])
        self.assertTrue(F.colorblind_conflicts(['#FF0000', '#00AA00']))

    def test_cli_check(self):
        fig, ax = plt.subplots(figsize=F.figsize('nature', 'single'))
        ax.plot([0, 1], [0, 1])
        fig.savefig('a.pdf')
        out = subprocess.run([sys.executable, F.__file__, 'check', 'a.pdf', '--venue', 'nature', '--preview'],
                             capture_output=True, text=True, encoding='utf-8', check=True).stdout
        r = json.loads(out)
        self.assertEqual(r['measured']['format'], 'pdf')
        self.assertTrue(Path(r['preview']).exists())

    @unittest.skipUnless(F.tikz_engine(), 'no TeX engine')
    def test_tikz(self):
        r = F.compile_tikz(r'\begin{tikzpicture}\draw[->] (0,0) -- (1,0) node[right]{$x$};\end{tikzpicture}', 'tikz/d')
        self.assertTrue(r['ok'], r)
        self.assertTrue(Path(r['pdf']).exists() and Path(r['svg']).exists() and Path(r['preview']).exists())
        bad = F.compile_tikz(r'\begin{tikzpicture}\undefinedmacro\end{tikzpicture}', 'tikz/bad')
        self.assertFalse(bad['ok'])
        self.assertTrue(bad.get('errors'))


class DataHelpers(unittest.TestCase):
    def test_summary_uses_sample_sd(self):
        s = D.summarize([1, 2, 3, 4])
        self.assertEqual(s['n'], 4)
        self.assertAlmostEqual(s['mean'], 2.5)
        self.assertAlmostEqual(s['sample_sd'], math.sqrt(5 / 3))
        self.assertLess(s['ci95'][0], 2.5)
        self.assertIsNone(D.summarize([3])['sample_sd'])

    def test_summarize_by_and_booktabs(self):
        import pandas as pd
        df = pd.DataFrame({'method': ['B', 'A', 'A', 'B'], 'score': [0.7, 0.9, 0.8, 0.6]})
        t = D.summarize_by(df, 'method', 'score')
        self.assertEqual(t['method'].tolist(), ['A', 'B'])
        rows = [{'m': r.method, 's': {'mean': r.mean, 'sd': r.sample_sd}} for r in t.itertuples()]
        tex = D.booktabs(rows, [('m', 'Method'), ('s', 'Score')], bold_best={'s': 'max'}, caption='c', label='tab:x')
        self.assertIn(r'\toprule', tex)
        self.assertIn(r'\textbf{0.85 $\pm$ 0.07}', tex)

    def test_compare_and_holm(self):
        c = D.compare([1, 2, 3, 4, 5], [3, 4, 5, 6, 7])
        self.assertEqual(c['test'], 'Welch t')
        self.assertLess(c['p'], 0.1)
        self.assertEqual(D.holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06])

    def test_logs_and_curves(self):
        rows = D.parse_log_metrics('epoch=1 loss=0.5 acc: 0.8\nnothing\nepoch=2 loss=0.25', keys=['loss'])
        self.assertEqual(rows, [{'loss': 0.5}, {'loss': 0.25}])
        agg = D.aggregate_curves([([0, 1, 2], [0, 1, 2]), ([0, 2], [2, 4])])
        self.assertEqual(agg['steps'], [0.0, 1.0, 2.0])
        self.assertEqual(agg['mean'], [1.0, 2.0, 3.0])
        self.assertAlmostEqual(D.ema([1, 1, 1])[-1], 1.0)

    def test_spectra(self):
        self.assertAlmostEqual(float(D.nm_to_ev(1239.84198)), 1.0, places=6)
        self.assertAlmostEqual(float(D.ev_to_nm(D.nm_to_ev(1550))), 1550)
        x = np.linspace(1549, 1551, 4001)
        y = D.lorentzian(x, 1550.0, 0.02, -0.8, 1.0)       # notch: dip of depth 0.8, FWHM 20 pm
        f = D.fwhm(x, y, dip=True)
        self.assertAlmostEqual(f['center'], 1550.0, places=3)
        self.assertAlmostEqual(f['fwhm'], 0.02, places=3)
        fit = D.fit_peak(x, y + np.random.default_rng(0).normal(0, 1e-3, x.size), dip=True, window=0.4)
        self.assertAlmostEqual(fit['fwhm'], 0.02, places=3)
        self.assertAlmostEqual(fit['q'], 1550 / 0.02, delta=1500)
        g = D.gaussian(x, 1550.0, 0.5, 1.0, 0.0)
        self.assertAlmostEqual(D.fwhm(x, g)['fwhm'], 0.5, places=3)
        peaks = D.find_peaks(x, D.lorentzian(x, 1549.5, 0.05, 1, 0) + D.lorentzian(x, 1550.5, 0.05, 0.5, 0))
        self.assertEqual([round(p['x'], 2) for p in peaks], [1549.5, 1550.5])
        self.assertAlmostEqual(D.fsr([1549.5, 1550.5, 1551.5])['fsr_mean'], 1.0)
        self.assertAlmostEqual(D.extinction_ratio_db(1.0, 0.01), 20.0)

    def test_fields(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / 'f.txt').write_text('% Model: x\n% x                y                emw.normE^2\n0 0 1\n1 0 2\n0 1 3\n1 1 4\n', encoding='utf-8')
        t = D.read_comsol_table(tmp / 'f.txt')
        self.assertEqual(t['columns'], ['x', 'y', 'emw.normE^2'])
        g = D.grid_from_points(t['data'][:, 0], t['data'][:, 1], t['data'][:, 2])
        self.assertEqual(g['z'].tolist(), [[1, 2], [3, 4]])
        (tmp / 'l.csv').write_text('x,y,E2\n0,0,1\n1,0,1\n', encoding='utf-8')
        self.assertEqual(D.read_lumerical_table(tmp / 'l.csv')['columns'], ['x', 'y', 'E2'])
        xs = np.linspace(-1, 1, 201)
        X, Y = np.meshgrid(xs, xs)
        I = np.exp(-(X ** 2 + Y ** 2) / 0.1)
        self.assertAlmostEqual(D.effective_mode_area(xs, xs, I), 2 * math.pi * 0.1 / 2 * 2, delta=0.02)

    def test_device_curves(self):
        I = np.linspace(0, 0.1, 101)
        P = np.where(I > 0.03, 0.5 * (I - 0.03), 1e-5 * I)
        li = D.li_threshold(I, P)
        self.assertAlmostEqual(li['threshold'], 0.03, places=4)
        self.assertAlmostEqual(li['slope_efficiency'], 0.5, places=4)
        self.assertAlmostEqual(float(D.responsivity(1e-3, 1e-3)), 1.0)
        self.assertAlmostEqual(float(D.quantum_efficiency(1.0, 1239.84198)), 1.0, places=5)
        V = np.linspace(0.1, 0.6, 50)
        vt = D.K_B * 300 / D.Q_E
        Id = 1e-12 * (np.exp(V / (1.5 * vt)) - 1)
        d = D.diode_ideality(V, Id, 300, v_range=(0.3, 0.6))
        self.assertAlmostEqual(d['ideality'], 1.5, places=2)
        self.assertAlmostEqual(D.series_resistance([0, 1, 2, 3], [0, 0.1, 0.2, 0.3]), 10.0)


if __name__ == '__main__':
    unittest.main()
