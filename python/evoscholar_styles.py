"""Figure style catalog for EvoScholar.

Wraps four MIT-licensed style libraries plus EvoScholar's own default:
  - SciencePlots (garrettj403/SciencePlots)   journal looks: science, ieee, nature, high-vis, ...
  - tueplots (pnkraemer/tueplots)             exact sizes and fonts for ML venues (NeurIPS, ICML, ...)
  - aquarel (lgienapp/aquarel)                themes for reports, posters and slides
  - cmcrameri (callumrollo/cmcrameri)          Crameri perceptually uniform colour maps

Usage in run_python:
    import evoscholar_styles as S
    S.use('sp-nature', venue='nature')   # style decides the look, the venue rule pack keeps size/fonts legal
    ...
    S.list_styles()                       # catalog

CLI:  python evoscholar_styles.py list | preview <id> <out.png>
"""
from __future__ import annotations

import json
import sys
from typing import Any

NO_LATEX = 'no-latex'

# id -> (label, library, group, description, spec)
_CATALOG: list[dict[str, Any]] = [
    {'id': 'evo-default', 'label': '内置 · 色盲友好', 'library': 'EvoScholar', 'group': '内置', 'description': 'Okabe-Ito 配色、细线、可编辑文字的 PDF/SVG；配合期刊规则包使用', 'spec': ('evo', None)},
    {'id': 'sp-science', 'label': 'Science 通用', 'library': 'SciencePlots', 'group': '期刊', 'description': '经典科研图：内向刻度、无网格、衬线字体', 'spec': ('mpl', ['science'])},
    {'id': 'sp-nature', 'label': 'Nature', 'library': 'SciencePlots', 'group': '期刊', 'description': 'Nature 系列：无衬线字体、较小字号', 'spec': ('mpl', ['science', 'nature'])},
    {'id': 'sp-ieee', 'label': 'IEEE', 'library': 'SciencePlots', 'group': '期刊', 'description': 'IEEE 期刊：单栏尺寸、黑白也能区分的线型、600 dpi', 'spec': ('mpl', ['science', 'ieee'])},
    {'id': 'sp-high-vis', 'label': '高辨识度', 'library': 'SciencePlots', 'group': '配色', 'description': '高对比颜色加不同线型，打印成黑白也能分清', 'spec': ('mpl', ['science', 'high-vis'])},
    {'id': 'sp-bright', 'label': 'Paul Tol · Bright', 'library': 'SciencePlots', 'group': '配色', 'description': '色盲友好的明亮离散配色', 'spec': ('mpl', ['science', 'bright'])},
    {'id': 'sp-vibrant', 'label': 'Paul Tol · Vibrant', 'library': 'SciencePlots', 'group': '配色', 'description': '色盲友好的鲜艳配色，适合幻灯片', 'spec': ('mpl', ['science', 'vibrant'])},
    {'id': 'sp-muted', 'label': 'Paul Tol · Muted', 'library': 'SciencePlots', 'group': '配色', 'description': '色盲友好的柔和配色，适合多条曲线', 'spec': ('mpl', ['science', 'muted'])},
    {'id': 'sp-retro', 'label': '复古', 'library': 'SciencePlots', 'group': '配色', 'description': '复古色调', 'spec': ('mpl', ['science', 'retro'])},
    {'id': 'sp-grid', 'label': '带网格', 'library': 'SciencePlots', 'group': '期刊', 'description': 'Science 风格加浅色网格，便于读数', 'spec': ('mpl', ['science', 'grid'])},
    {'id': 'sp-cjk', 'label': '中文学位论文', 'library': 'SciencePlots', 'group': '中文', 'description': '中文宋体 / 黑体回退，适合学位论文和中文期刊', 'spec': ('mpl', ['science', 'cjk-sc-font'])},
    {'id': 'tp-neurips2024', 'label': 'NeurIPS 2024', 'library': 'tueplots', 'group': '会议', 'description': 'NeurIPS 模板的精确图宽与字号', 'spec': ('tue', 'neurips2024')},
    {'id': 'tp-icml2024', 'label': 'ICML 2024', 'library': 'tueplots', 'group': '会议', 'description': 'ICML 模板的精确图宽与字号', 'spec': ('tue', 'icml2024')},
    {'id': 'tp-iclr2024', 'label': 'ICLR 2024', 'library': 'tueplots', 'group': '会议', 'description': 'ICLR 模板的精确图宽与字号', 'spec': ('tue', 'iclr2024')},
    {'id': 'tp-cvpr2024', 'label': 'CVPR 2024', 'library': 'tueplots', 'group': '会议', 'description': 'CVPR 模板的精确图宽与字号', 'spec': ('tue', 'cvpr2024')},
    {'id': 'tp-aaai2024', 'label': 'AAAI 2024', 'library': 'tueplots', 'group': '会议', 'description': 'AAAI 模板的精确图宽与字号', 'spec': ('tue', 'aaai2024')},
    {'id': 'tp-jmlr2001', 'label': 'JMLR', 'library': 'tueplots', 'group': '会议', 'description': 'JMLR 期刊模板的图宽与字号', 'spec': ('tue', 'jmlr2001')},
    {'id': 'tp-beamer', 'label': 'Beamer 幻灯片', 'library': 'tueplots', 'group': '报告', 'description': '16:9 幻灯片里的图', 'spec': ('tue', 'beamer_moml')},
    {'id': 'aq-scientific', 'label': 'Aquarel · Scientific', 'library': 'aquarel', 'group': '报告', 'description': '干净的科研报告主题', 'spec': ('aq', 'scientific')},
    {'id': 'aq-minimal', 'label': 'Aquarel · Minimal', 'library': 'aquarel', 'group': '报告', 'description': '极简：去掉多余边框和刻度', 'spec': ('aq', 'minimal_light')},
    {'id': 'aq-arctic', 'label': 'Aquarel · Arctic', 'library': 'aquarel', 'group': '报告', 'description': '冷色调，适合海报', 'spec': ('aq', 'arctic_light')},
    {'id': 'aq-boxy', 'label': 'Aquarel · Boxy', 'library': 'aquarel', 'group': '报告', 'description': '带边框的方正风格', 'spec': ('aq', 'boxy_light')},
    {'id': 'aq-umbra', 'label': 'Aquarel · Umbra', 'library': 'aquarel', 'group': '报告', 'description': '暖灰色调', 'spec': ('aq', 'umbra_light')},
    {'id': 'cmc-batlow', 'label': 'Crameri · batlow', 'library': 'cmcrameri', 'group': '色图', 'description': '感知均匀的顺序色图，适合热图和场分布；离散配色取自 batlowS', 'spec': ('cmc', ('batlow', 'batlowS'))},
    {'id': 'cmc-vik', 'label': 'Crameri · vik', 'library': 'cmcrameri', 'group': '色图', 'description': '感知均匀的发散色图，适合正负对称的场（如相位、偏差）', 'spec': ('cmc', ('vik', 'batlowS'))},
    {'id': 'cmc-roma', 'label': 'Crameri · roma', 'library': 'cmcrameri', 'group': '色图', 'description': '感知均匀的彩虹替代色图', 'spec': ('cmc', ('roma', 'romaO'))},
]

LIBRARIES = {
    'EvoScholar': {'url': 'https://github.com/Dylannn-7/EvoScholar', 'license': 'MIT'},
    'SciencePlots': {'url': 'https://github.com/garrettj403/SciencePlots', 'license': 'MIT', 'cite': 'Garrett, J. D. SciencePlots. Zenodo, doi:10.5281/zenodo.4106649'},
    'tueplots': {'url': 'https://github.com/pnkraemer/tueplots', 'license': 'MIT'},
    'aquarel': {'url': 'https://github.com/lgienapp/aquarel', 'license': 'MIT'},
    'cmcrameri': {'url': 'https://github.com/callumrollo/cmcrameri', 'license': 'MIT', 'cite': 'Crameri, F. Scientific colour maps. Zenodo, doi:10.5281/zenodo.1243862（作者请求在论文中引用）'},
}

CJK_FONTS = ['Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', 'Noto Sans CJK SC', 'Source Han Sans SC', 'PingFang SC', 'Heiti SC', 'Microsoft YaHei', 'SimHei', 'WenQuanYi Micro Hei']


def list_styles(meta: bool = False) -> list[dict]:
    out = []
    for s in _CATALOG:
        lib = LIBRARIES[s['library']]
        row = {k: v for k, v in s.items() if k != 'spec'} | {'url': lib['url'], 'license': lib['license'], 'cite': lib.get('cite')}
        if meta:
            try:
                row['meta'] = style_meta(s['id'])
            except Exception as e:  # a broken optional library must not hide the catalog
                row['meta'] = {'error': str(e)}
        out.append(row)
    return out


def _installed_cjk() -> list[str]:
    from matplotlib import font_manager
    names = {f.name for f in font_manager.fontManager.ttflist}
    return [f for f in CJK_FONTS if f in names]


def _add_cjk_fallback() -> None:
    """Keep Chinese labels readable in every style by appending installed CJK fonts as fallbacks."""
    import matplotlib as mpl
    cjk = _installed_cjk()
    if not cjk:
        return
    for key in ('font.serif', 'font.sans-serif'):
        cur = list(mpl.rcParams.get(key) or [])
        mpl.rcParams[key] = cur + [f for f in cjk if f not in cur]
    # Per-glyph fallback only walks the explicit font.family list, so expand the generic family.
    from matplotlib import font_manager
    have = {f.name for f in font_manager.fontManager.ttflist}
    fam: list[str] = []
    for f in mpl.rcParams['font.family']:
        names = mpl.rcParams.get(f'font.{f}') if f in ('serif', 'sans-serif', 'monospace', 'cursive', 'fantasy') else [f]
        fam += [n for n in (names or []) if n in have and n not in fam and n not in cjk][:2]
    mpl.rcParams['font.family'] = fam + cjk[:3] + ['DejaVu Sans']
    mpl.rcParams['axes.unicode_minus'] = False


def use(style: str | None = None, venue: str | dict | None = None) -> dict:
    """Apply a catalog style, then (optionally) a venue rule pack for legal sizes and fonts.
    The style's colours survive the venue step; sizes and fonts follow the venue."""
    import matplotlib as mpl
    import matplotlib.pyplot as plt
    entry = next((s for s in _CATALOG if s['id'] == (style or 'evo-default')), None)
    if entry is None:
        raise ValueError(f'没有出图风格 {style}；可选：{", ".join(s["id"] for s in _CATALOG)}')
    plt.style.use('default')
    mpl.rcParams['backend'] = 'Agg'
    kind, arg = entry['spec']
    if kind == 'mpl':
        import scienceplots  # noqa: F401  (registers the styles)
        plt.style.use(list(arg) + [NO_LATEX])
    elif kind == 'tue':
        from tueplots import bundles
        b = getattr(bundles, arg)
        try:
            params = b(usetex=False)
        except TypeError:
            params = b()
        mpl.rcParams.update(params)
        mpl.rcParams['text.usetex'] = False
    elif kind == 'aq':
        from aquarel import load_theme
        load_theme(arg).apply()
    elif kind == 'cmc':
        import cmcrameri.cm as cmc
        from cycler import cycler
        cmap, cat = arg
        mpl.rcParams['image.cmap'] = f'cmc.{cmap}'
        colors = getattr(cmc, cat).colors
        mpl.rcParams['axes.prop_cycle'] = cycler(color=[colors[i] for i in range(0, len(colors), max(1, len(colors) // 8))][:8])
    keep = {k: mpl.rcParams[k] for k in ('axes.prop_cycle', 'image.cmap', 'axes.grid', 'xtick.direction', 'ytick.direction', 'axes.spines.top', 'axes.spines.right') if k in mpl.rcParams}
    info: dict[str, Any] = {'style': entry['id'], 'library': entry['library']}
    if venue is not None or kind == 'evo':
        import evoscholar_fig as F
        info |= F.apply_style(venue) if venue is not None else F.apply_style(None)
        if kind != 'evo':
            mpl.rcParams.update(keep)
    _add_cjk_fallback()
    return info


def style_meta(style: str) -> dict:
    """The hard facts that tell styles apart: palette, line styles, font, size, figure width, grid, colour map."""
    import matplotlib as mpl
    from matplotlib.colors import to_hex
    use(style)
    cyc = mpl.rcParams['axes.prop_cycle'].by_key()
    fam = list(mpl.rcParams['font.family'])
    font = fam[0] if fam else 'sans-serif'
    if font in ('serif', 'sans-serif', 'monospace'):
        font = (mpl.rcParams.get(f'font.{font}') or [font])[0]
    w, h = mpl.rcParams['figure.figsize']
    return {
        'colors': [to_hex(c) for c in cyc.get('color', [])][:8],
        'linestyles': len(set(map(str, cyc.get('linestyle', [])))) > 1,
        'font': font,
        'font_pt': round(float(mpl.rcParams['font.size']), 1),
        'width_in': round(float(w), 2),
        'height_in': round(float(h), 2),
        'grid': bool(mpl.rcParams['axes.grid']),
        'ticks': mpl.rcParams['xtick.direction'],
        'cmap': str(mpl.rcParams['image.cmap']).replace('cmc.', ''),
        'dpi': int(float(mpl.rcParams['savefig.dpi'])) if str(mpl.rcParams['savefig.dpi']) != 'figure' else None,
    }


def preview(style: str, out: str) -> str:
    """Gallery sample built to expose what differs between styles: every palette colour and line style
    (curves), fills (grouped bars with error bars), grid and ticks (scatter + fit), and for colour-map
    styles the map itself. Rendered at a fixed canvas so font sizes compare honestly across styles."""
    import numpy as np
    import matplotlib as mpl
    import matplotlib.pyplot as plt
    use(style)
    zh = style == 'sp-cjk'
    entry = next(s for s in _CATALOG if s['id'] == style)
    rng = np.random.default_rng(3)
    n_col = max(3, min(6, len(mpl.rcParams['axes.prop_cycle'].by_key().get('color', [])) or 6))
    fig, axes = plt.subplots(1, 3, figsize=(6.6, 2.25), dpi=170, gridspec_kw={'width_ratios': [1.25, 1, 1]})
    # (a) curves: palette order, line styles, line width
    ax = axes[0]
    x = np.linspace(0, 1, 60)
    for i in range(n_col):
        ax.plot(x, (i + 1) * 0.35 + 0.25 * np.sin(2 * np.pi * (x + i / 7)) * (1 - 0.4 * x), label=f'{"样品" if zh else "S"}{i + 1}')
    ax.set_xlabel('时间 (s)' if zh else 'Time (s)')
    ax.set_ylabel('信号' if zh else 'Signal')
    ax.legend(fontsize='x-small', ncol=2, loc='upper left', handlelength=1.6)
    ax.set_title('(a)', loc='left')
    # (b) grouped bars with error bars: fills and edge treatment
    ax = axes[1]
    groups = ['A', 'B', 'C'] if not zh else ['甲', '乙', '丙']
    k = min(4, n_col)
    width = 0.8 / k
    for j in range(k):
        vals = 1 + 0.6 * rng.random(3) + 0.2 * j
        ax.bar(np.arange(3) + (j - (k - 1) / 2) * width, vals, width * 0.92, yerr=0.08 + 0.05 * rng.random(3), capsize=1.5, label=f'M{j + 1}')
    ax.set_xticks(range(3), groups)
    ax.set_ylabel('得分' if zh else 'Score')
    ax.set_title('(b)', loc='left')
    # (c) colour map for colour-map styles, otherwise scatter + fit + band (grid, ticks, markers)
    ax = axes[2]
    if entry['spec'][0] == 'cmc':
        gx, gy = np.meshgrid(np.linspace(-3, 3, 90), np.linspace(-3, 3, 90))
        field = np.sin(gx * 1.4) * np.cos(gy * 1.1) * np.exp(-(gx ** 2 + gy ** 2) / 10)
        im = ax.imshow(field, origin='lower', extent=(-3, 3, -3, 3))
        fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
        ax.set_xlabel('x (µm)')
        ax.set_ylabel('y (µm)')
    else:
        for j in range(3):
            xs = rng.normal(j * 1.2, 0.35, 25)
            ax.scatter(xs, 0.8 * xs + rng.normal(0, 0.3, 25) + j * 0.2, s=7, label=f'{"组" if zh else "G"}{j + 1}')
        xx = np.linspace(-0.6, 3.2, 40)
        ax.plot(xx, 0.8 * xx + 0.2, color='0.25', lw=0.9)
        ax.fill_between(xx, 0.8 * xx, 0.8 * xx + 0.4, color='0.5', alpha=0.15, lw=0)
        ax.set_xlabel('x')
        ax.set_ylabel('y')
        ax.legend(fontsize='x-small', loc='upper left', handletextpad=0.2)
    ax.set_title('(c)', loc='left')
    if not fig.get_constrained_layout():
        fig.tight_layout(w_pad=0.6)
    fig.savefig(out, dpi=170, bbox_inches='tight', facecolor=mpl.rcParams.get('figure.facecolor', 'white'))
    plt.close(fig)
    return out


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'list'
    if cmd == 'list':
        print(json.dumps(list_styles(meta='--meta' in sys.argv), ensure_ascii=False))
    elif cmd == 'preview':
        print(json.dumps({'path': preview(sys.argv[2], sys.argv[3])}))
    else:
        raise SystemExit('用法：evoscholar_styles.py list | preview <id> <out.png>')
