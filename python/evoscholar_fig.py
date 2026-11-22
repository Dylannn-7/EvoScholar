"""EvoScholar figure helpers: venue rule packs, styling, post-render checks, previews, TikZ.

Usage inside run_python:

    import evoscholar_fig as F
    F.apply_style('nature')                       # fonts, sizes, palette, editable text
    fig, ax = plt.subplots(figsize=F.figsize('nature', 'single', aspect=0.75))
    ...
    report = F.save(fig, 'fig1', venue='nature')  # writes fig1.pdf/.svg/.png + checks + preview
    print(F.format_report(report))

Rule packs live in rulepacks/figures/<venue>.yaml and contain only numbers taken from the
venue's author guidelines; a missing (null) rule is skipped, never guessed.

CLI (used by the figure_check tool):  python evoscholar_fig.py check <file> [--venue V] [--columns single | --target-width-mm 89]
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Iterable

MM_PER_IN = 25.4
PT_PER_IN = 72.0
RULES_DIR = Path(__file__).resolve().parent.parent / 'rulepacks' / 'figures'
# Colour-blind-safe default when a venue gives no palette (Wong 2011, also Nature's example palette).
WONG = ['#000000', '#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7']


# ---------------------------------------------------------------- rule packs

def list_venues() -> list[str]:
    return sorted(p.stem for p in RULES_DIR.glob('*.yaml'))


def load_rules(venue: str | dict | None) -> dict:
    """Rule pack as a dict. Accepts a venue id, an already-loaded dict, or None (no rules)."""
    if venue is None:
        return {}
    if isinstance(venue, dict):
        return venue
    if not re.fullmatch(r'[a-z0-9-]+', venue):
        raise ValueError(f'无效的期刊标识：{venue}')
    path = RULES_DIR / f'{venue}.yaml'
    if not path.exists():
        raise ValueError(f'没有规则包 {venue}；可用：{", ".join(list_venues())}')
    try:
        import yaml
    except ImportError as e:  # pragma: no cover
        raise RuntimeError('需要 PyYAML：npm run setup:python') from e
    return yaml.safe_load(path.read_text(encoding='utf-8')) or {}


def _get(rules: dict, *keys, default=None):
    cur: Any = rules
    for k in keys:
        if not isinstance(cur, dict) or cur.get(k) is None:
            return default
        cur = cur[k]
    return cur


def widths_mm(rules: dict) -> dict[str, float]:
    w = rules.get('width_mm') or {}
    return {k: float(v) for k, v in w.items() if v is not None and k not in ('min', 'max')}


def figsize(venue: str | dict, columns: str = 'single', aspect: float = 0.75, height_mm: float | None = None) -> tuple[float, float]:
    """(width, height) in inches for matplotlib. `aspect` = height / width; capped at the venue's max height."""
    rules = load_rules(venue)
    w = widths_mm(rules)
    if columns in w:
        width = w[columns]
    elif _get(rules, 'width_mm', 'max'):
        lo, hi = _get(rules, 'width_mm', 'min', default=0), _get(rules, 'width_mm', 'max')
        width = hi if columns == 'double' else max(lo, min(hi, 89.0))
    else:
        raise ValueError(f'{rules.get("id")} 没有 {columns} 宽度；可选：{", ".join(w) or "min/max"}')
    height = height_mm if height_mm is not None else width * aspect
    max_h = _get(rules, 'max_height_mm')
    if max_h:
        height = min(height, float(max_h))
    return (width / MM_PER_IN, height / MM_PER_IN)


# ---------------------------------------------------------------- styling

def apply_style(venue: str | dict | None = None, base_pt: float | None = None) -> dict:
    """Set matplotlib rcParams for a venue: font family/size inside the allowed range, editable
    text in PDF/SVG, colour-blind-safe cycle, no gridlines when the venue forbids them."""
    import matplotlib as mpl
    from cycler import cycler

    rules = load_rules(venue)
    lo = _get(rules, 'font', 'min_pt')
    hi = _get(rules, 'font', 'max_pt')
    size = base_pt or (hi if hi else 8.0)
    if lo:
        size = max(size, lo)
    if hi:
        size = min(size, hi)
    small = max(lo or 0, size - 1) if lo else size - 1
    families = _get(rules, 'font', 'family') or ['Arial', 'Helvetica', 'DejaVu Sans']
    serif = any('Times' in f or 'Cambria' in f for f in families[:1])
    palette = _get(rules, 'color', 'palette') or WONG
    params = {
        'font.family': 'serif' if serif else 'sans-serif',
        ('font.serif' if serif else 'font.sans-serif'): list(families) + ['DejaVu Serif' if serif else 'DejaVu Sans'],
        'font.size': size,
        'axes.labelsize': size,
        'axes.titlesize': size,
        'xtick.labelsize': small,
        'ytick.labelsize': small,
        'legend.fontsize': small,
        'axes.linewidth': 0.6,
        'lines.linewidth': 1.0,
        'xtick.major.width': 0.6,
        'ytick.major.width': 0.6,
        'xtick.direction': 'out',
        'ytick.direction': 'out',
        'axes.grid': _get(rules, 'axes', 'gridlines') is True,
        'axes.prop_cycle': cycler(color=[c for c in palette if c.upper() != '#000000'] + ['#000000']),
        'pdf.fonttype': 42,           # TrueType, editable (Nature: Type 42, never Type 3)
        'ps.fonttype': 42,
        'svg.fonttype': 'none',       # keep text as text in SVG
        'savefig.bbox': None,         # keep the exact canvas size we chose
        'savefig.dpi': max(_get(rules, 'raster_min_dpi', default=300), _get(rules, 'line_art_min_dpi', default=0) or 0, 300),
        'figure.dpi': 100,
    }
    mpl.rcParams.update(params)
    return {'venue': rules.get('id'), 'font_pt': size, 'tick_pt': small, 'palette': palette}


def panel_labels(fig, axes: Iterable | None = None, venue: str | dict | None = None, x: float = -0.18, y: float = 1.05):
    """Label panels a, b, c (Nature style) or (a), (b) depending on the rule pack."""
    rules = load_rules(venue)
    style = _get(rules, 'panel_label', 'style', default='lowercase')
    size = _get(rules, 'panel_label', 'size_pt')
    weight = _get(rules, 'panel_label', 'weight', default='bold' if style == 'lowercase' else 'normal')
    axs = list(axes) if axes is not None else fig.axes
    for i, ax in enumerate(axs):
        t = chr(ord('a') + i)
        label = f'({t})' if style == 'parenthesized' else t
        ax.text(x, y, label, transform=ax.transAxes, fontweight=weight, va='bottom', ha='left',
                **({'fontsize': size} if size else {}))


# ---------------------------------------------------------------- colour checks

def _hex_rgb(c) -> tuple[float, float, float]:
    from matplotlib.colors import to_rgb
    return tuple(to_rgb(c))


def _lin(v):
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def _srgb(v):
    v = min(1.0, max(0.0, v))
    return 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055


# Machado et al. (2009) full-severity simulation matrices in linear RGB.
_CVD = {
    'protan': ((0.152286, 1.052583, -0.204868), (0.114503, 0.786281, 0.099216), (-0.003882, -0.048116, 1.051998)),
    'deutan': ((0.367322, 0.860646, -0.227968), (0.280085, 0.672501, 0.047413), (-0.011820, 0.042940, 0.968881)),
}


def simulate_cvd(color, kind: str = 'deutan') -> tuple[float, float, float]:
    r, g, b = (_lin(v) for v in _hex_rgb(color))
    m = _CVD[kind]
    return tuple(_srgb(m[i][0] * r + m[i][1] * g + m[i][2] * b) for i in range(3))


def _lab(rgb):
    r, g, b = (_lin(v) for v in rgb)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    return (116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z)))


def color_distance(c1, c2) -> float:
    """CIE76 ΔE between two colours (sRGB inputs)."""
    a, b = _lab(c1 if isinstance(c1, tuple) else _hex_rgb(c1)), _lab(c2 if isinstance(c2, tuple) else _hex_rgb(c2))
    return math.dist(a, b)


def colorblind_conflicts(colors: Iterable, min_delta_e: float = 12.0) -> list[dict]:
    """Pairs of colours that become hard to tell apart for protan/deutan viewers."""
    uniq = []
    for c in colors:
        h = '#%02X%02X%02X' % tuple(round(v * 255) for v in _hex_rgb(c))
        if h not in uniq:
            uniq.append(h)
    out = []
    for i in range(len(uniq)):
        for j in range(i + 1, len(uniq)):
            if color_distance(uniq[i], uniq[j]) < min_delta_e:
                continue  # already similar in normal vision; not a CVD-specific problem
            for kind in ('protan', 'deutan'):
                d = color_distance(simulate_cvd(uniq[i], kind), simulate_cvd(uniq[j], kind))
                if d < min_delta_e:
                    out.append({'pair': [uniq[i], uniq[j]], 'vision': kind, 'delta_e': round(d, 1)})
                    break
    return out


# ---------------------------------------------------------------- figure checks

_UNIT = re.compile(r'\(([^()]+)\)\s*$|\[([^\[\]]+)\]\s*$|（[^（）]+）\s*$|/\s*\S+\s*$')
_TRAINING_COUNT = re.compile(r'(?:training\s+)?(?:epochs?|steps?|iterations?)', re.IGNORECASE)


def _issue(level: str, rule: str, message: str) -> dict:
    return {'level': level, 'rule': rule, 'message': message}


def _is_numeric_axis(axis) -> bool:
    try:
        units = axis.get_units()
        if units is not None and not isinstance(units, (int, float)):
            # categorical axes carry a mapping of category -> position
            if hasattr(units, '_mapping'):
                return False
    except Exception:
        pass
    labels = [t.get_text() for t in axis.get_ticklabels() if t.get_text()]
    if not labels:
        return True
    numeric = sum(bool(re.fullmatch(r'[−\-+]?[\d.,]+(e[−\-+]?\d+)?%?|\$.*\$', s.strip())) for s in labels)
    return numeric >= len(labels) / 2


def _check_status(issues: list[dict], has_rules: bool) -> str:
    if any(i['level'] == 'error' for i in issues):
        return 'fail'
    if issues:
        return 'review'
    return 'pass' if has_rules else 'measured'


def check_figure(fig, venue: str | dict | None = None, columns: str | None = None, tol: float = 0.02) -> dict:
    """Inspect a matplotlib figure against a venue's rules (size, font sizes, axis labels/units,
    gridlines, colour-blind safety). Draws the canvas so tick labels exist. Returns
    {ok, status, issues:[{level: error|warning, rule, message}], measured:{...}}."""
    rules = load_rules(venue)
    fig.canvas.draw()
    issues: list[dict] = []
    w_in, h_in = fig.get_size_inches()
    w_mm, h_mm = w_in * MM_PER_IN, h_in * MM_PER_IN
    measured: dict[str, Any] = {'width_mm': round(w_mm, 1), 'height_mm': round(h_mm, 1)}

    # --- size
    allowed = widths_mm(rules)
    if columns and columns in allowed:
        if abs(w_mm - allowed[columns]) > allowed[columns] * tol:
            issues.append(_issue('error', 'width', f'图宽 {w_mm:.1f} mm，{columns} 栏应为 {allowed[columns]:g} mm'))
    elif allowed:
        fits = [k for k, v in allowed.items() if abs(w_mm - v) <= v * tol]
        biggest = max(allowed.values())
        if w_mm > biggest * (1 + tol):
            issues.append(_issue('error', 'width', f'图宽 {w_mm:.1f} mm 超过最大宽度 {biggest:g} mm'))
        elif not fits:
            opts = '、'.join(f'{k} {v:g} mm' for k, v in allowed.items())
            issues.append(_issue('warning', 'width', f'图宽 {w_mm:.1f} mm 不等于规定栏宽（{opts}），排版时会被缩放，字号随之改变'))
        else:
            measured['columns'] = fits[0]
    lo_w, hi_w = _get(rules, 'width_mm', 'min'), _get(rules, 'width_mm', 'max')
    if lo_w and w_mm < lo_w * (1 - tol):
        issues.append(_issue('error', 'width', f'图宽 {w_mm:.1f} mm 小于最小宽度 {lo_w:g} mm'))
    if hi_w and w_mm > hi_w * (1 + tol):
        issues.append(_issue('error', 'width', f'图宽 {w_mm:.1f} mm 大于最大宽度 {hi_w:g} mm'))
    max_h = _get(rules, 'max_height_mm')
    if max_h and h_mm > max_h * (1 + tol):
        issues.append(_issue('error', 'height', f'图高 {h_mm:.1f} mm 超过上限 {max_h:g} mm'))

    # --- fonts
    import matplotlib.text as mtext
    sizes = []
    lo, hi = _get(rules, 'font', 'min_pt'), _get(rules, 'font', 'max_pt')
    label_pt = _get(rules, 'panel_label', 'size_pt')
    too_small, too_big = [], []
    for t in fig.findobj(mtext.Text):
        s = t.get_text()
        if not t.get_visible() or not s.strip():
            continue
        pt = float(t.get_fontsize())
        sizes.append(pt)
        is_panel = bool(re.fullmatch(r'\(?[a-z]\)?', s.strip())) and t.get_fontweight() in ('bold', 700, 'heavy')
        if lo and pt < lo - 1e-6:
            too_small.append(f'"{s[:20]}" {pt:g} pt')
        if hi and pt > hi + 1e-6 and not (is_panel and label_pt and pt <= label_pt + 1e-6):
            too_big.append(f'"{s[:20]}" {pt:g} pt')
    if sizes:
        measured['font_pt'] = {'min': min(sizes), 'max': max(sizes)}
    if too_small:
        issues.append(_issue('error', 'font.min', f'字号低于 {lo:g} pt：' + '；'.join(too_small[:6])))
    if too_big:
        issues.append(_issue('warning', 'font.max', f'字号高于 {hi:g} pt：' + '；'.join(too_big[:6])))

    # --- text running off the canvas (cut off in the exported file unless saved with bbox_inches='tight')
    clipped = _clipped_texts(fig)
    if clipped:
        listed = '；'.join(f'「{s[:24]}」（{side}）' for s, side in clipped[:6])
        issues.append(_issue('warning', 'text.clipped', f'这些文字超出画布，导出后会被裁切：{listed}。'
                             '用 constrained_layout / tight_layout 留出边距，或保存时加 bbox_inches=\'tight\'（之后复核图宽）'))
        measured['clipped_text'] = len(clipped)

    # --- axes: labels, units, ticks, gridlines
    units_required = _get(rules, 'axes', 'units_required')
    for k, ax in enumerate(fig.axes):
        if not ax.axison or not (ax.lines or ax.collections or ax.patches or ax.images):
            continue
        name = f'子图 {k + 1}'
        for axis, label in ((ax.xaxis, ax.get_xlabel()), (ax.yaxis, ax.get_ylabel())):
            which = 'x' if axis is ax.xaxis else 'y'
            if not label.strip():
                if _is_numeric_axis(axis) and axis.get_visible() and any(t.get_text() for t in axis.get_ticklabels()):
                    issues.append(_issue('error', 'axes.label', f'{name} 的 {which} 轴没有标签'))
                continue
            if (units_required and _is_numeric_axis(axis)
                    and not _UNIT.search(label) and not _TRAINING_COUNT.fullmatch(label.strip())):
                issues.append(_issue('warning', 'axes.units', f'{name} 的 {which} 轴标签「{label}」没有单位（应写成「量 (单位)」；无量纲量写 (a.u.) 或说明）'))
        if _get(rules, 'axes', 'gridlines') is False and any(gl.get_visible() for gl in ax.get_xgridlines() + ax.get_ygridlines()):
            issues.append(_issue('warning', 'axes.gridlines', f'{name} 有背景网格线，该期刊要求去掉'))

    # --- colours
    colors = []
    for ax in fig.axes:
        for ln in ax.lines:
            if ln.get_visible() and len(ln.get_xdata()) > 1:
                colors.append(ln.get_color())
        for c in ax.collections:
            try:
                fc = c.get_facecolor()
                if len(fc) and len(fc) <= 12:
                    colors.extend(tuple(x[:3]) for x in fc)
            except Exception:
                pass
    if _get(rules, 'color', 'colorblind_safe'):
        conflicts = colorblind_conflicts(colors)
        if conflicts:
            pairs = '；'.join(f'{c["pair"][0]} 与 {c["pair"][1]}（{"红色盲" if c["vision"] == "protan" else "绿色盲"} ΔE={c["delta_e"]}）' for c in conflicts[:4])
            issues.append(_issue('warning', 'color.cvd', f'这些颜色对色觉障碍读者难以区分：{pairs}'))
    if _get(rules, 'color', 'not_color_only'):
        for k, ax in enumerate(fig.axes):
            sig = [(ln.get_linestyle(), ln.get_marker()) for ln in ax.lines if ln.get_visible() and len(ln.get_xdata()) > 1]
            if len(sig) > 1 and len(set(sig)) == 1:
                issues.append(_issue('warning', 'color.only', f'子图 {k + 1} 的 {len(sig)} 条曲线只靠颜色区分，加上线型或标记'))
    status = _check_status(issues, bool(rules))
    return {'ok': status != 'fail', 'status': status, 'venue': rules.get('id'), 'issues': issues, 'measured': measured}


def _drawn_texts(fig):
    """Visible, non-empty text artists that are actually drawn (tick labels outside the view are skipped)."""
    out = list(fig.texts)
    for ax in fig.axes:
        if not ax.get_visible():
            continue
        out += [ax.title, ax._left_title, ax._right_title] if hasattr(ax, '_left_title') else [ax.title]
        out += list(ax.texts)
        if ax.axison:
            for axis in (ax.xaxis, ax.yaxis):
                if not axis.get_visible():
                    continue
                out.append(axis.label)
                lo, hi = sorted(axis.get_view_interval())
                span = (hi - lo) or 1.0
                for tick in axis.get_major_ticks() + axis.get_minor_ticks():
                    loc = tick.get_loc()
                    if loc is None or not (lo - 1e-9 * span <= loc <= hi + 1e-9 * span):
                        continue
                    out += [t for t in (tick.label1, tick.label2) if t.get_visible()]
        legend = ax.get_legend()
        if legend is not None and legend.get_visible():
            out += list(legend.get_texts())
            if legend.get_title().get_text():
                out.append(legend.get_title())
    if getattr(fig, '_suptitle', None) is not None:
        out.append(fig._suptitle)
    seen, result = set(), []
    for t in out:
        if t is None or id(t) in seen or not t.get_visible() or not t.get_text().strip():
            continue
        seen.add(id(t))
        result.append(t)
    return result


def _clipped_texts(fig, tol_px: float = 0.5) -> list[tuple[str, str]]:
    """Texts whose bounding box crosses the figure edge: [(text, side)], side in 左/右/上/下."""
    renderer = fig.canvas.get_renderer()
    fb = fig.bbox
    found = []
    for t in _drawn_texts(fig):
        try:
            bb = t.get_window_extent(renderer)
        except Exception:
            continue
        sides = [name for name, over in (('左', fb.x0 - bb.x0), ('右', bb.x1 - fb.x1),
                                          ('下', fb.y0 - bb.y0), ('上', bb.y1 - fb.y1)) if over > tol_px]
        if sides:
            found.append((t.get_text().strip(), '、'.join(sides)))
    return found


# ---------------------------------------------------------------- file checks

def _len_mm(value: str | None) -> float | None:
    if not value:
        return None
    m = re.fullmatch(r'\s*([\d.]+)\s*(pt|px|in|mm|cm)?\s*', value)
    if not m:
        return None
    v, u = float(m.group(1)), m.group(2) or 'px'
    return v * {'pt': MM_PER_IN / PT_PER_IN, 'px': MM_PER_IN / 96, 'in': MM_PER_IN, 'mm': 1, 'cm': 10}[u]


def check_file(path: str | os.PathLike, venue: str | dict | None = None, line_art: bool = True,
               *, columns: str | None = None, target_width_mm: float | None = None) -> dict:
    """Check the saved file. For raster images, use the selected print width to check effective DPI."""
    if columns and target_width_mm is not None:
        raise ValueError('columns 和 target_width_mm 只能指定一个')
    if target_width_mm is not None and (not math.isfinite(target_width_mm) or target_width_mm <= 0):
        raise ValueError('目标栏宽必须是正数（mm）')
    rules = load_rules(venue)
    p = Path(path)
    issues: list[dict] = []
    measured: dict[str, Any] = {'file': p.name, 'format': p.suffix.lower().lstrip('.')}
    if not p.exists() or p.stat().st_size == 0:
        return {'ok': False, 'status': 'fail', 'issues': [_issue('error', 'file', f'{p.name} 不存在或为空')], 'measured': measured}
    ext = p.suffix.lower()
    w_mm = h_mm = None
    if ext == '.svg':
        root = ET.parse(p).getroot()
        if root.tag.split('}')[-1] != 'svg':
            issues.append(_issue('error', 'file', 'SVG 根元素不是 <svg>'))
        w_mm, h_mm = _len_mm(root.get('width')), _len_mm(root.get('height'))
        texts = [e for e in root.iter() if e.tag.split('}')[-1] == 'text']
        measured['text_elements'] = len(texts)
        if _get(rules, 'font', 'editable') and not texts:
            issues.append(_issue('warning', 'font.editable', 'SVG 里没有 <text> 元素，文字可能被转成了曲线；设置 svg.fonttype="none"'))
    elif ext == '.pdf':
        try:
            import pymupdf as fitz
        except ImportError:  # pragma: no cover
            import fitz
        with fitz.open(p) as doc:
            page = doc[0]
            w_mm, h_mm = page.rect.width * MM_PER_IN / PT_PER_IN, page.rect.height * MM_PER_IN / PT_PER_IN
            fonts = page.get_fonts()
            measured['fonts'] = sorted({f'{f[3]} ({f[2]})' for f in fonts})
            if any(f[2] == 'Type3' for f in fonts) and _get(rules, 'font', 'editable'):
                issues.append(_issue('error', 'font.type3', 'PDF 含 Type 3 字体，期刊要求 TrueType（Type 42）：设置 pdf.fonttype=42'))
            if _get(rules, 'font', 'editable') and not fonts:
                issues.append(_issue('warning', 'font.editable', 'PDF 没有嵌入字体，文字可能被转成了曲线'))
    elif ext in ('.png', '.jpg', '.jpeg', '.tif', '.tiff'):
        from PIL import Image
        with Image.open(p) as im:
            px_w, px_h = im.size
            dpi = im.info.get('dpi')
        measured['pixels'] = [px_w, px_h]
        source_dpi = float(dpi[0]) if dpi and dpi[0] > 0 and math.isfinite(dpi[0]) else None
        if source_dpi is not None:
            measured['dpi'] = round(source_dpi)
            if dpi[1] > 0 and math.isfinite(dpi[1]):
                w_mm, h_mm = px_w / source_dpi * MM_PER_IN, px_h / dpi[1] * MM_PER_IN

        target = target_width_mm if target_width_mm is not None else widths_mm(rules).get(columns)
        dpi_to_check = source_dpi
        if target is not None:
            w_mm, h_mm = target, target * px_h / px_w
            dpi_to_check = px_w / target * MM_PER_IN
            measured['target_width_mm'] = target
            measured['effective_dpi'] = round(dpi_to_check, 2)
        elif columns:
            issues.append(_issue('warning', 'width.target', f'规则包没有 {columns} 栏宽，请提供目标栏宽（mm）'))

        need = (_get(rules, 'line_art_min_dpi') if line_art else None) or _get(rules, 'raster_min_dpi')
        if need and (not columns or target is not None):
            if dpi_to_check is None:
                issues.append(_issue('warning', 'dpi', f'{p.name} 没有记录 DPI，请提供目标栏宽以核对是否达到 {need} dpi'))
            elif dpi_to_check + 0.5 < need:
                detail = f'按 {target:g} mm 栏宽计算的有效分辨率 {dpi_to_check:.2f} dpi' if target is not None else f'分辨率 {dpi_to_check:.0f} dpi'
                issues.append(_issue('error', 'dpi', f'{detail} 低于要求 {need} dpi'))
        if _get(rules, 'formats', 'vector') and line_art:
            issues.append(_issue('warning', 'format', '数据图建议交矢量格式（PDF/EPS/SVG），位图只用于照片'))
    else:
        issues.append(_issue('warning', 'format', f'未知格式 {ext}'))
    if w_mm:
        measured['width_mm'] = round(w_mm, 1)
        measured['height_mm'] = round(h_mm or 0, 1)
        allowed = widths_mm(rules)
        biggest = max(allowed.values()) if allowed else _get(rules, 'width_mm', 'max')
        if biggest and w_mm > biggest * 1.02:
            issues.append(_issue('error', 'width', f'{p.name} 宽 {w_mm:.1f} mm，超过 {biggest:g} mm'))
        if 'target_width_mm' in measured:
            minimum = _get(rules, 'width_mm', 'min')
            if minimum and w_mm < minimum * 0.98:
                issues.append(_issue('error', 'width', f'目标栏宽 {w_mm:.1f} mm 小于最小宽度 {minimum:g} mm'))
    elif ext == '.svg' and (widths_mm(rules) or _get(rules, 'width_mm', 'max')):
        issues.append(_issue('warning', 'width', 'SVG 缺少可换算为毫米的宽度，请核对投稿尺寸'))
    max_mb = _get(rules, 'max_file_mb')
    if max_mb and p.stat().st_size > max_mb * 1024 * 1024:
        issues.append(_issue('error', 'file.size', f'{p.name} 超过 {max_mb} MB'))
    status = _check_status(issues, bool(rules))
    return {'ok': status != 'fail', 'status': status, 'venue': rules.get('id'), 'issues': issues, 'measured': measured}


# ---------------------------------------------------------------- previews and saving

def preview(path: str | os.PathLike, out: str | os.PathLike | None = None, dpi: int = 150) -> str:
    """Render a PDF/SVG (first page) to PNG so the model can look at it with read_file."""
    p = Path(path)
    out = Path(out) if out else p.with_name(p.stem + '.preview.png')
    if p.suffix.lower() in ('.png', '.jpg', '.jpeg'):
        return str(p)
    try:
        import pymupdf as fitz
    except ImportError:  # pragma: no cover
        import fitz
    with fitz.open(p) as doc:
        pix = doc[0].get_pixmap(dpi=dpi)
        pix.save(out)
    return str(out)


def save(fig, stem: str, venue: str | dict | None = None, formats: Iterable[str] = ('pdf', 'svg', 'png'),
         columns: str | None = None, dpi: int | None = None) -> dict:
    """Save a figure in several formats at its exact canvas size, run figure + file checks and
    write <stem>.preview.png. Returns a report dict (see format_report)."""
    rules = load_rules(venue)
    report = check_figure(fig, rules, columns=columns)
    files = []
    dpi = dpi or max(_get(rules, 'line_art_min_dpi', default=0) or 0, _get(rules, 'raster_min_dpi', default=0) or 0, 300)
    formats = list(formats)
    has_vector = any(e in ('pdf', 'svg', 'eps') for e in formats)
    for ext in formats:
        path = Path(f'{stem}.{ext}')
        path.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(path, dpi=dpi if ext in ('png', 'jpg', 'tif', 'tiff') else None)
        r = check_file(path, rules, columns=columns)
        if has_vector and 'pixels' in r['measured']:  # a raster copy next to a vector file is for convenience
            r['issues'] = [i for i in r['issues'] if i['rule'] != 'format']
            r['status'] = _check_status(r['issues'], bool(rules))
        files.append({'path': str(path), **r})
        report['issues'].extend(r['issues'])
    report['files'] = files
    src = next((f['path'] for f in files if f['path'].endswith(('.pdf', '.svg'))), files[0]['path'] if files else None)
    report['preview'] = preview(src) if src else None
    report['status'] = _check_status(report['issues'], bool(rules))
    report['ok'] = report['status'] != 'fail'
    return report


def format_report(report: dict) -> str:
    m = report.get('measured', {})
    status = report.get('status') or _check_status(report.get('issues', []), bool(report.get('venue')))
    label = {'pass': '✓ 通过', 'review': '待核对', 'fail': '✗ 有错误', 'measured': '仅测量'}[status]
    size = f'{m["width_mm"]}×{m["height_mm"]} mm' if 'width_mm' in m else '未知'
    head = f'{label}（规则包 {report.get("venue") or "无"}）· 尺寸 {size}'
    if 'effective_dpi' in m:
        head += f' · {m["target_width_mm"]:g} mm 栏宽下有效 DPI {m["effective_dpi"]:g}'
    elif 'dpi' in m:
        head += f' · 文件 DPI {m["dpi"]}'
    if m.get('font_pt'):
        head += f" · 字号 {m['font_pt']['min']:g}–{m['font_pt']['max']:g} pt"
    lines = [head]
    for f in report.get('files', []):
        layout = f['measured']
        if 'effective_dpi' in layout:
            lines.append(f'- {Path(f["path"]).name} · {layout["target_width_mm"]:g} mm 栏宽下有效 DPI {layout["effective_dpi"]:g}')
    for i in report.get('issues', []):
        lines.append(f"- [{'错误' if i['level'] == 'error' else '提醒'}] {i['message']}")
    if report.get('preview'):
        lines.append(f"预览：{report['preview']}（用 read_file 查看效果）")
    return '\n'.join(lines)


# ---------------------------------------------------------------- TikZ

STANDALONE = r"""\documentclass[tikz,border=2pt]{standalone}
\usepackage{amsmath,amssymb}
\usepackage{tikz}
\usetikzlibrary{arrows.meta,positioning,calc,shapes,decorations.pathreplacing}
%s
\begin{document}
%s
\end{document}
"""


def tikz_engine() -> str | None:
    for name in ('xelatex', 'lualatex', 'pdflatex', 'tectonic'):
        if shutil.which(name):
            return name
    return None


def compile_tikz(source: str, stem: str = 'diagram', preamble: str = '', engine: str | None = None, timeout: int = 120) -> dict:
    """Compile a TikZ picture (or a full standalone document) to <stem>.pdf, <stem>.svg and a PNG
    preview. Returns {ok, pdf, svg, preview, log_tail}. Needs a TeX installation."""
    engine = engine or tikz_engine()
    if not engine:
        return {'ok': False, 'error': '没有找到 TeX 引擎（xelatex / lualatex / pdflatex / tectonic）'}
    doc = source if '\\documentclass' in source else STANDALONE % (preamble, source)
    out = Path(f'{stem}.pdf').resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out.parent) as tmp:
        tex = Path(tmp) / 'figure.tex'
        tex.write_text(doc, encoding='utf-8')
        cmd = [engine, 'figure.tex'] if engine == 'tectonic' else [engine, '-interaction=nonstopmode', '-halt-on-error', 'figure.tex']
        try:
            r = subprocess.run(cmd, cwd=tmp, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return {'ok': False, 'error': f'{engine} 超时（{timeout}s）'}
        log = (r.stdout or '') + (r.stderr or '')
        errors = [l for l in log.splitlines() if l.startswith('!')]
        pdf = Path(tmp) / 'figure.pdf'
        if r.returncode != 0 or not pdf.exists():
            return {'ok': False, 'engine': engine, 'errors': errors[:5], 'log_tail': '\n'.join(log.splitlines()[-25:])}
        shutil.copy(pdf, out)
    try:
        import pymupdf as fitz
    except ImportError:  # pragma: no cover
        import fitz
    with fitz.open(out) as d:
        svg = d[0].get_svg_image(text_as_path=False)
        size_mm = [round(d[0].rect.width * MM_PER_IN / PT_PER_IN, 1), round(d[0].rect.height * MM_PER_IN / PT_PER_IN, 1)]
    svg_path = out.with_suffix('.svg')
    svg_path.write_text(svg, encoding='utf-8')
    return {'ok': True, 'engine': engine, 'pdf': str(out), 'svg': str(svg_path), 'preview': preview(out), 'size_mm': size_mm}


# ---------------------------------------------------------------- CLI

def _cli(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog='evoscholar_fig')
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('check')
    c.add_argument('file')
    c.add_argument('--venue')
    c.add_argument('--photo', action='store_true', help='位图是照片而不是线稿')
    c.add_argument('--preview', action='store_true')
    width = c.add_mutually_exclusive_group()
    width.add_argument('--columns', choices=('half', 'single', 'double'))
    width.add_argument('--target-width-mm', type=float)
    sub.add_parser('venues')
    a = ap.parse_args(argv)
    if a.cmd == 'venues':
        print(json.dumps([{'id': v, 'name': load_rules(v).get('name'), 'width_mm': load_rules(v).get('width_mm')} for v in list_venues()], ensure_ascii=False))
        return 0
    r = check_file(a.file, a.venue, line_art=not a.photo, columns=a.columns, target_width_mm=a.target_width_mm)
    r['venue'] = a.venue
    if a.preview:
        try:
            r['preview'] = preview(a.file)
        except Exception as e:  # pragma: no cover
            r['issues'].append(_issue('warning', 'preview', f'无法生成预览：{e}'))
            if r['ok']:
                r['status'] = 'review'
    print(json.dumps(r, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    for _s in (sys.stdout, sys.stderr):  # Windows consoles default to a legacy code page; output is UTF-8 JSON / Chinese
        try:
            _s.reconfigure(encoding='utf-8')
        except Exception:
            pass
    sys.exit(_cli(sys.argv[1:]))
