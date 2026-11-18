---
name: optics-spectra
version: 1
description: 光谱数据处理：峰 / 谷定位、FWHM、品质因子 Q、洛伦兹 / 高斯拟合、自由光谱范围、消光比、nm↔eV↔THz、dB↔线性。处理透射谱、反射谱、PL、拉曼、微环谐振谱时先读本技能。
---

# 光谱分析

## 1. 读数据
- 先确认横轴单位（nm、µm、eV、THz、cm⁻¹）和纵轴是线性还是 dB；不确定时看文件头或问用户。
- 换算：`D.nm_to_ev`、`D.ev_to_nm`、`D.nm_to_thz`、`D.db_to_linear`、`D.linear_to_db`（hc = 1239.84198 eV·nm）。

## 2. 峰与线宽
```python
import evoscholar_data as D
peaks = D.find_peaks(x, y, dips=True, n=5)      # 谐振谷用 dips=True；按显著性排序
w = D.fwhm(x, y, index=peaks[0]['index'], dip=True)          # 插值求半高全宽
fit = D.fit_peak(x, y, model='lorentzian', dip=True, window=0.5)  # center、fwhm、误差、R²、q
D.q_factor(fit['center'], fit['fwhm'])          # 载荷 Q = λ0 / Δλ
D.fsr([p['x'] for p in peaks])                  # 自由光谱范围
D.extinction_ratio_db(y_max, y_min)             # 消光比
```
- **dB 谱求 FWHM 要先转线性**（半高 = 线性功率的一半，即 −3 dB）；直接在 dB 上取半高是错的。
- 谐振峰用洛伦兹拟合，非均匀展宽（如 PL）用高斯；报告拟合 R²，R² 低时说明原因。
- FWHM 小于采样间隔的几倍时，结果受分辨率限制，要写明光谱仪分辨率。
- 区分载荷 Q（测量值）与本征 Q（需要耦合状态信息），不要混用。

## 3. 作图
- 横轴「Wavelength (nm)」，纵轴「Transmission (dB)」或「Normalized intensity (a.u.)」。
- 在图上标注拟合曲线和 FWHM / Q 数值时，数值与表格一致。
- 出图规范见 `figure-style` 技能。
