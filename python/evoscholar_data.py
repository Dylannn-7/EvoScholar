"""EvoScholar data helpers: deterministic functions the data/figure skills call from run_python.

    import evoscholar_data as D

Sections: ML results (summaries, tests, booktabs tables), training curves, optical spectra
(peaks, FWHM, Q, Lorentzian/Gaussian fits, unit conversions), field exports (COMSOL /
Lumerical text tables), device curves (L-I threshold, slope efficiency, responsivity, ideality).
Only numpy/scipy/pandas are required.
"""
from __future__ import annotations

import io
import math
import re
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

# Physical constants (CODATA 2018 exact values where defined).
H = 6.62607015e-34          # J s
C = 299792458.0             # m / s
Q_E = 1.602176634e-19       # C
K_B = 1.380649e-23          # J / K
HC_EV_NM = H * C / Q_E * 1e9  # ≈ 1239.84198 eV·nm


# ================================================================ ML results

def summarize(values: Iterable[float]) -> dict:
    """n, mean, sample SD (ddof=1), SEM and a two-sided 95 % t confidence interval."""
    from scipy import stats
    x = np.asarray([v for v in values if v is not None and not (isinstance(v, float) and math.isnan(v))], dtype=float)
    n = int(x.size)
    if n == 0:
        return {'n': 0, 'mean': None, 'sample_sd': None, 'sem': None, 'ci95': None}
    mean = float(x.mean())
    if n == 1:
        return {'n': 1, 'mean': mean, 'sample_sd': None, 'sem': None, 'ci95': None}
    sd = float(x.std(ddof=1))
    sem = sd / math.sqrt(n)
    h = float(stats.t.ppf(0.975, n - 1)) * sem
    return {'n': n, 'mean': mean, 'sample_sd': sd, 'sem': sem, 'ci95': [mean - h, mean + h]}


def summarize_by(df, by: str | list[str], value: str):
    """Group a DataFrame and summarise one column; returns a DataFrame sorted by the group keys
    with columns [*by, n, mean, sample_sd, sem, ci95_low, ci95_high]."""
    import pandas as pd
    rows = []
    for key, g in df.groupby(by, sort=True):
        s = summarize(g[value].tolist())
        key = key if isinstance(key, tuple) else (key,)
        rows.append({**dict(zip([by] if isinstance(by, str) else by, key)), 'n': s['n'], 'mean': s['mean'], 'sample_sd': s['sample_sd'],
                     'sem': s['sem'], 'ci95_low': s['ci95'][0] if s['ci95'] else None, 'ci95_high': s['ci95'][1] if s['ci95'] else None})
    return pd.DataFrame(rows)


def compare(a: Sequence[float], b: Sequence[float], paired: bool = False) -> dict:
    """Two-sample comparison: Welch t-test (or paired t), Mann-Whitney U / Wilcoxon, Cohen's d / d_z."""
    from scipy import stats
    a, b = np.asarray(a, float), np.asarray(b, float)
    if paired:
        if a.size != b.size:
            raise ValueError('配对比较要求两组长度相同')
        d = a - b
        t = stats.ttest_rel(a, b)
        w = stats.wilcoxon(a, b) if np.any(d != 0) else None
        dz = float(d.mean() / d.std(ddof=1)) if d.size > 1 and d.std(ddof=1) > 0 else None
        return {'test': 'paired t', 't': float(t.statistic), 'p': float(t.pvalue), 'wilcoxon_p': float(w.pvalue) if w else None,
                'mean_diff': float(d.mean()), 'cohens_dz': dz, 'n': int(a.size)}
    t = stats.ttest_ind(a, b, equal_var=False)
    u = stats.mannwhitneyu(a, b, alternative='two-sided')
    pooled = math.sqrt(((a.size - 1) * a.var(ddof=1) + (b.size - 1) * b.var(ddof=1)) / (a.size + b.size - 2)) if a.size + b.size > 2 else 0
    return {'test': 'Welch t', 't': float(t.statistic), 'p': float(t.pvalue), 'mannwhitney_p': float(u.pvalue),
            'mean_diff': float(a.mean() - b.mean()), 'cohens_d': float((a.mean() - b.mean()) / pooled) if pooled else None,
            'n': [int(a.size), int(b.size)]}


def holm(pvalues: Sequence[float]) -> list[float]:
    """Holm–Bonferroni adjusted p-values (same order as input)."""
    p = np.asarray(pvalues, float)
    order = np.argsort(p)
    m = p.size
    adj = np.empty(m)
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, (m - rank) * p[i])
        adj[i] = min(1.0, running)
    return adj.tolist()


def fmt_pm(mean: float | None, sd: float | None, digits: int = 2) -> str:
    if mean is None:
        return '--'
    return f'{mean:.{digits}f}' if sd is None else f'{mean:.{digits}f} $\\pm$ {sd:.{digits}f}'


def booktabs(rows: list[dict], columns: list[tuple[str, str]], caption: str = '', label: str = '',
             bold_best: dict[str, str] | None = None, digits: int = 2) -> str:
    """LaTeX booktabs table. `columns` = [(key, header)]; a cell may be a number, a string, or a
    dict {mean, sd}. `bold_best` = {key: 'max'|'min'} bolds the best mean in that column."""
    def val(c):
        return c.get('mean') if isinstance(c, dict) else c if isinstance(c, (int, float)) else None
    best = {}
    for key, how in (bold_best or {}).items():
        vals = [val(r.get(key)) for r in rows if val(r.get(key)) is not None]
        if vals:
            best[key] = max(vals) if how == 'max' else min(vals)

    def cell(key, c):
        if isinstance(c, dict):
            s = fmt_pm(c.get('mean'), c.get('sd'), digits)
        elif isinstance(c, float):
            s = f'{c:.{digits}f}'
        else:
            s = str(c) if c is not None else '--'
        s = s.replace('%', r'\%').replace('&', r'\&').replace('_', r'\_') if not isinstance(c, (dict, float, int)) else s
        if key in best and val(c) is not None and abs(val(c) - best[key]) < 1e-12:
            s = r'\textbf{' + s + '}'
        return s
    head = ' & '.join(h for _, h in columns)
    body = '\n'.join('    ' + ' & '.join(cell(k, r.get(k)) for k, _ in columns) + r' \\' for r in rows)
    return '\n'.join([r'\begin{table}[t]', r'  \centering', *( [f'  \\caption{{{caption}}}'] if caption else []), *( [f'  \\label{{{label}}}'] if label else []),
                      f'  \\begin{{tabular}}{{l{"c" * (len(columns) - 1)}}}', r'    \toprule', f'    {head} \\\\', r'    \midrule', body,
                      r'    \bottomrule', r'  \end{tabular}', r'\end{table}'])


_KV = re.compile(r'([A-Za-z_][\w./-]*)\s*[:=]\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)')


def parse_log_metrics(text: str, keys: Iterable[str] | None = None) -> list[dict]:
    """Extract `key=value` / `key: value` numbers per line from training logs (one dict per line
    that has at least one match). Restrict to `keys` if given."""
    want = set(keys) if keys else None
    out = []
    for line in text.splitlines():
        found = {k: float(v) for k, v in _KV.findall(line) if want is None or k in want}
        if found:
            out.append(found)
    return out


# ================================================================ training curves

def ema(y: Sequence[float], alpha: float = 0.1) -> np.ndarray:
    """Exponential moving average with bias correction (TensorBoard-style smoothing = 1 - alpha)."""
    y = np.asarray(y, float)
    out = np.empty_like(y)
    acc, w = 0.0, 0.0
    for i, v in enumerate(y):
        acc = (1 - alpha) * acc + alpha * v
        w = (1 - alpha) * w + alpha
        out[i] = acc / w
    return out


def aggregate_curves(curves: Sequence[tuple[Sequence[float], Sequence[float]]], steps: Sequence[float] | None = None) -> dict:
    """Align several (steps, values) runs on a common step grid (linear interpolation, no
    extrapolation) and return mean, sample SD and n at each step."""
    if steps is None:
        lo = max(min(s) for s, _ in curves)
        hi = min(max(s) for s, _ in curves)
        steps = sorted({float(x) for s, _ in curves for x in s if lo <= x <= hi})
    grid = np.asarray(steps, float)
    mat = np.vstack([np.interp(grid, np.asarray(s, float), np.asarray(v, float), left=np.nan, right=np.nan) for s, v in curves])
    n = np.sum(~np.isnan(mat), axis=0)
    mean = np.nanmean(mat, axis=0)
    sd = np.array([np.nanstd(mat[:, j], ddof=1) if n[j] > 1 else np.nan for j in range(mat.shape[1])])
    return {'steps': grid.tolist(), 'mean': mean.tolist(), 'sample_sd': sd.tolist(), 'n': n.astype(int).tolist()}


# ================================================================ optical spectra

def nm_to_ev(nm):
    return HC_EV_NM / np.asarray(nm, float)


def ev_to_nm(ev):
    return HC_EV_NM / np.asarray(ev, float)


def nm_to_thz(nm):
    return C / (np.asarray(nm, float) * 1e-9) / 1e12


def db_to_linear(db):
    return 10 ** (np.asarray(db, float) / 10)


def linear_to_db(x):
    return 10 * np.log10(np.asarray(x, float))


def find_peaks(x, y, dips: bool = False, prominence: float | None = None, n: int | None = None) -> list[dict]:
    """Peaks (or dips, e.g. ring-resonator notches) sorted by prominence. Returns x, y, index, prominence."""
    from scipy.signal import find_peaks as fp
    x, y = np.asarray(x, float), np.asarray(y, float)
    s = -y if dips else y
    if prominence is None:
        prominence = 0.1 * (s.max() - s.min())
    idx, props = fp(s, prominence=prominence)
    order = np.argsort(props['prominences'])[::-1]
    out = [{'index': int(idx[i]), 'x': float(x[idx[i]]), 'y': float(y[idx[i]]), 'prominence': float(props['prominences'][i])} for i in order]
    return out[:n] if n else out


def fwhm(x, y, index: int | None = None, dip: bool = False, baseline: float | None = None) -> dict:
    """Full width at half maximum around a peak (or half depth of a dip) by linear interpolation
    of the two crossings. `baseline` defaults to the minimum (peak) / maximum (dip) of y."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    if index is None:
        index = int(np.argmin(y) if dip else np.argmax(y))
    if dip:
        base = y.max() if baseline is None else baseline
        half = base - (base - y[index]) / 2
        inside = lambda v: v < half
    else:
        base = y.min() if baseline is None else baseline
        half = base + (y[index] - base) / 2
        inside = lambda v: v > half

    def cross(step):
        i = index
        while 0 <= i + step < len(y) and inside(y[i + step]):
            i += step
        j = i + step
        if not 0 <= j < len(y):
            return None
        x0, x1, y0, y1 = x[i], x[j], y[i], y[j]
        return float(x0 + (half - y0) * (x1 - x0) / (y1 - y0)) if y1 != y0 else float(x1)
    left, right = cross(-1), cross(1)
    if left is None or right is None:
        return {'center': float(x[index]), 'fwhm': None, 'left': left, 'right': right, 'half_level': float(half),
                'warning': '半高处没有两侧交点（谱线被截断或基线不对）'}
    return {'center': float(x[index]), 'fwhm': abs(right - left), 'left': min(left, right), 'right': max(left, right), 'half_level': float(half)}


def q_factor(center: float, width: float) -> float:
    """Loaded Q = λ0 / Δλ (same units)."""
    return float(center) / float(width)


def lorentzian(x, x0, gamma, amp, offset):
    """amp / (1 + ((x - x0) / (gamma/2))^2) + offset; gamma is the FWHM."""
    return amp / (1 + ((np.asarray(x) - x0) / (gamma / 2)) ** 2) + offset


def gaussian(x, x0, fwhm_, amp, offset):
    sigma = fwhm_ / (2 * math.sqrt(2 * math.log(2)))
    return amp * np.exp(-0.5 * ((np.asarray(x) - x0) / sigma) ** 2) + offset


def fit_peak(x, y, model: str = 'lorentzian', dip: bool = False, window: float | None = None) -> dict:
    """Least-squares Lorentzian/Gaussian fit around the main peak (or dip). Returns center, fwhm,
    amplitude, offset, their 1-σ errors, R² and Q = center / fwhm."""
    from scipy.optimize import curve_fit
    x, y = np.asarray(x, float), np.asarray(y, float)
    guess = fwhm(x, y, dip=dip)
    x0 = guess['center']
    w0 = guess['fwhm'] or (x.max() - x.min()) / 10
    if window:
        m = np.abs(x - x0) <= window / 2
        x, y = x[m], y[m]
    f = lorentzian if model == 'lorentzian' else gaussian
    amp0 = (y.min() - y.max()) if dip else (y.max() - y.min())
    off0 = y.max() if dip else y.min()
    p, cov = curve_fit(f, x, y, p0=[x0, w0, amp0, off0], maxfev=20000)
    err = np.sqrt(np.diag(cov)) if np.all(np.isfinite(cov)) else [None] * 4
    resid = y - f(x, *p)
    r2 = 1 - np.sum(resid ** 2) / np.sum((y - y.mean()) ** 2)
    width = abs(float(p[1]))
    return {'model': model, 'center': float(p[0]), 'fwhm': width, 'amplitude': float(p[2]), 'offset': float(p[3]),
            'errors': {'center': _f(err[0]), 'fwhm': _f(err[1])}, 'r2': float(r2), 'q': q_factor(p[0], width) if width else None}


def _f(v):
    return None if v is None else float(v)


def extinction_ratio_db(y_max: float, y_min: float, db_input: bool = False) -> float:
    """Extinction ratio in dB from max/min transmission (linear, or already in dB)."""
    return float(y_max - y_min) if db_input else float(10 * math.log10(y_max / y_min))


def fsr(peaks_x: Sequence[float]) -> dict:
    """Free spectral range from consecutive resonance positions."""
    p = np.sort(np.asarray(peaks_x, float))
    d = np.diff(p)
    return {'fsr_mean': float(d.mean()), 'fsr_sd': float(d.std(ddof=1)) if d.size > 1 else None, 'spacings': d.tolist()}


# ================================================================ field exports

def read_comsol_table(path: str | Path) -> dict:
    """COMSOL 'Export > Data' text file: comment lines start with '%', the last comment line holds
    column names, data are whitespace-separated. Returns {columns, data (ndarray)}."""
    lines = Path(path).read_text(encoding='utf-8', errors='replace').splitlines()
    header = [l for l in lines if l.startswith('%')]
    cols = re.split(r'\s{2,}|\t', header[-1].lstrip('% ').strip()) if header else []
    rows = [l for l in lines if l.strip() and not l.startswith('%')]
    data = np.loadtxt(io.StringIO('\n'.join(rows)))
    data = np.atleast_2d(data)
    if len(cols) != data.shape[1]:
        cols = [f'c{i}' for i in range(data.shape[1])]
    return {'columns': cols, 'data': data}


def read_lumerical_table(path: str | Path) -> dict:
    """Lumerical text/CSV export (comma or whitespace separated, optional header line)."""
    text = Path(path).read_text(encoding='utf-8', errors='replace')
    lines = [l for l in text.splitlines() if l.strip()]
    sep = ',' if ',' in lines[0] else None
    first = lines[0].split(sep)
    has_header = any(re.search(r'[A-Za-z]', c) and not re.fullmatch(r'\s*[-+]?[\d.]+([eE][-+]?\d+)?\s*', c) for c in first)
    cols = [c.strip() for c in first] if has_header else [f'c{i}' for i in range(len(first))]
    body = lines[1:] if has_header else lines
    data = np.atleast_2d(np.loadtxt(io.StringIO('\n'.join(body)), delimiter=sep))
    return {'columns': cols, 'data': data}


def grid_from_points(x, y, v) -> dict:
    """Scattered (x, y, value) points on a regular mesh → 2-D array for imshow/pcolormesh."""
    x, y, v = (np.asarray(a, float) for a in (x, y, v))
    xs, ys = np.unique(np.round(x, 12)), np.unique(np.round(y, 12))
    grid = np.full((ys.size, xs.size), np.nan)
    ix = np.searchsorted(xs, np.round(x, 12))
    iy = np.searchsorted(ys, np.round(y, 12))
    grid[iy, ix] = v
    return {'x': xs, 'y': ys, 'z': grid, 'filled': float(np.mean(~np.isnan(grid)))}


def effective_mode_area(x, y, intensity) -> float:
    """A_eff = (∬|E|² dA)² / ∬|E|⁴ dA on a regular grid (intensity = |E|²)."""
    I = np.nan_to_num(np.asarray(intensity, float))
    dx = float(np.mean(np.diff(x)))
    dy = float(np.mean(np.diff(y)))
    return float((I.sum() * dx * dy) ** 2 / ((I ** 2).sum() * dx * dy))


def confinement_factor(x, y, intensity, mask) -> float:
    """Fraction of |E|² inside a region (boolean mask on the same grid)."""
    I = np.nan_to_num(np.asarray(intensity, float))
    return float(I[np.asarray(mask, bool)].sum() / I.sum())


# ================================================================ device curves

def li_threshold(current, power, fit_fraction: float = 0.3) -> dict:
    """Laser threshold from an L-I curve: linear fit of the top `fit_fraction` of the above-threshold
    region, extrapolated to zero power. Also returns slope efficiency (W/A if inputs are A and W)."""
    I, P = np.asarray(current, float), np.asarray(power, float)
    order = np.argsort(I)
    I, P = I[order], P[order]
    k = max(3, int(len(I) * fit_fraction))
    a, b = np.polyfit(I[-k:], P[-k:], 1)
    ith = -b / a if a else None
    # second-derivative estimate as a cross-check
    d2 = np.gradient(np.gradient(P, I), I)
    ith_d2 = float(I[int(np.argmax(d2))])
    return {'threshold': float(ith) if ith is not None else None, 'slope_efficiency': float(a), 'threshold_d2': ith_d2,
            'fit_points': int(k)}


def responsivity(photocurrent_a, optical_power_w, dark_current_a: float = 0.0):
    """R = (I_ph − I_dark) / P_opt in A/W."""
    return (np.asarray(photocurrent_a, float) - dark_current_a) / np.asarray(optical_power_w, float)


def quantum_efficiency(responsivity_a_per_w, wavelength_nm):
    """External quantum efficiency η = R · hc / (q λ)."""
    return np.asarray(responsivity_a_per_w, float) * HC_EV_NM / np.asarray(wavelength_nm, float)


def diode_ideality(voltage, current, temperature_k: float = 300.0, v_range: tuple[float, float] | None = None) -> dict:
    """Ideality factor n and saturation current from the exponential region of a forward I-V curve:
    ln I = ln I_s + qV / (n k T)."""
    V, I = np.asarray(voltage, float), np.asarray(current, float)
    m = (I > 0) & (V > 0)
    if v_range:
        m &= (V >= v_range[0]) & (V <= v_range[1])
    slope, intercept = np.polyfit(V[m], np.log(I[m]), 1)
    vt = K_B * temperature_k / Q_E
    return {'ideality': float(1 / (slope * vt)), 'saturation_current': float(math.exp(intercept)), 'points': int(m.sum())}


def series_resistance(voltage, current, top_fraction: float = 0.2) -> float:
    """Differential resistance dV/dI in the high-current region (linear fit of the top fraction)."""
    V, I = np.asarray(voltage, float), np.asarray(current, float)
    order = np.argsort(I)
    k = max(3, int(len(I) * top_fraction))
    a, _ = np.polyfit(I[order][-k:], V[order][-k:], 1)
    return float(a)
