# AXON 复刻说明（参考资料）

来源：用户 2026-11-18 提供的 AXON「Motion research hub」复刻说明。本文件是 `docs/frontend-visual-plan.md` 引用的「原说明」，第 7 天 AXON 换肤时使用。

为了开源仓库的合规，以下内容已从原文中去掉：外站视频素材链接（4 个 R2 视频）、three.js 的 CDN 链接（改为本地 vendor）、原站的联系邮箱和页面文案。EvoScholar 的文案和区块见视觉方案 §2；**数值参数（§7 粒子、§8 流体、相机）原样保留**，放进 `apps/web/public/fx/config.js`。

---

## 1. 素材（已改写）

| 用途 | EvoScholar 做法 |
| --- | --- |
| 卡片视频 | 不使用原站视频；会话卡片用会话里最后生成的图或文字预览 |
| 粒子贴图 matcap | 64×64 柔和灰色球体明暗（通用 matcap），用 canvas 程序化生成或内嵌 data URI |
| three.js | 0.150.1 UMD（全局 `THREE`），本地放 `apps/web/public/vendor/three.min.js`（MIT） |

## 2. 字体

系统等宽字体栈，不加载网络字体：`"SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace`（EvoScholar 需追加中文回退，见视觉方案 §3）。UI 文字一律大写、13 px、line-height 1.35、letter-spacing 0.02em。

## 3. 设计令牌

```
--accent: #aa88ff   (headings, chip highlight)
--text:   #dddddd
--muted:  #8a8a8a
--chip:   #1c1c1c
--line:   #2a2a2a
body background #000, html/body height 100%, overflow hidden
```

## 4. 图层

1. `canvas#bg`：fixed，铺满视口，z-index 0。WebGL renderer，pixel ratio = min(devicePixelRatio, 2)，清屏色黑。
2. `.ui`：fixed inset 0，z-index 1，`pointer-events: none`（链接和卡片列表重新开启 pointer events）。文字块用 `mix-blend-mode: plus-lighter`，在粒子上发光；卡片不混合。

## 5. UI 版式（桌面尺寸）

- **Brand** `.brand`：absolute top 24 left 24，flex row gap 14。40×40 SVG 标志：半径 18.5 px 的圆，白色描边 1.6，内部一个白色 8 角星多边形。名称 20 px 白色；副标题 11 px muted，margin-top 2。
- **Counter** `.counter`：absolute top 24 right 24，44×44 圆形，1 px `--line` 边框，背景 #0a0a0a，文字 14 px 白色居中。
- **Tags** `.tags`：absolute top 120 left 24，宽 320，flex wrap gap 6。chip：背景 `--chip`，padding 5px 9px，11 px，颜色 #cfcfcf。第一个 chip 为激活态：背景 #e6e6e6，文字 #000。
- **Card list** `.list`：absolute top 250 left 24 bottom 0，宽 320，纵向滚动，隐藏滚动条。每张 `.card`：padding 18px 0，1 px 上边框 `--line`。`.thumb` 高 160、圆角 2、背景 #0a0a0a、overflow hidden、内容 cover。`.meta`：flex space-between、gap 16、margin-top 10、12 px；左列白色、右列 muted 右对齐；两列都是两行（`white-space: pre-line`）。
- **Text column** `.about`：absolute right 90，top 50% translateY(-50%)，宽 380。区块间距 2.2em。`h2` 13 px accent 色，margin-bottom 1em。段落两端对齐，margin-bottom 1em。列表 `list-style: inside`。链接为块级、带下划线、margin 4px 0，悬停 300 ms 渐变到 70% 不透明度。区块名用 `[方括号]` 形式。

## 6. 响应式

- ≤1100 px：文字列 right 24、宽 320。
- ≤760 px：隐藏 `.list` 和 `.tags`；文字列改为 left 24 / right 24 / bottom 24，去掉 transform，段落左对齐。

## 7. 粒子系统

**场景。** 透视相机 FOV 30，near 0.1，far 1000，基准位置 (-1.17, 0, 6)，看向原点。一个 group 承载点云：position (0.343, 0.16, -1)，rotation（角度）(-28.4, 390, 4.92)，scale (5, 5, 6)。

**注视相机。** 每帧目标位置 = 基准位置 + x 方向 (mouse.x 从 0..width 映射到 -1..1) × (-1)，y 方向 (mouse.y 从 0..height 映射到 -1..1) × 2；相机以 0.05 的系数 lerp 过去，并看向原点。

**数量。** 桌面 262,144 点（512×512 位置纹理），移动端 16,384 点。每个点有一个取值 0..1 的 `random` vec4 属性，用 `position.xy` 作为 UV 从浮点 RGBA 纹理里查自己的位置。

**模拟**（ping-pong 浮点渲染目标，每帧一个全屏 pass）。输入：当前位置纹理、origin 纹理（初始随机位置，均匀分布在 [-1,1]³）、random 属性、`time`（秒）、`HZ`（= dt × 60）、流体速度纹理、流体密度纹理、投影矩阵（相机 projection × 相机 world 的逆）、model 矩阵（group world）、normal 矩阵（相机 world）。每个粒子：

```
if (length(pos) > 0.7) pos /= 2.0;
pos += curlNoise(pos * 0.1 + time * 0.05) * 1.0 * 0.0002 * HZ;        // uCurlNoiseScale 1, uCurlTimeScale 0.5, uCurlNoiseSpeed 1
vec3 gradient = sdfNormal(pos);   // central differences, step 0.001
float sdf = sdfShape(pos);
pos += cross(normalize(pos), normalize(gradient)) * 0.0005;           // swirl along the surface
pos += -gradient * sdf * 0.5;                                          // pull onto the surface
pos += (origin - pos) * 0.0002 * HZ;                                   // spring back to origin
// mouse fluid
vec2 screenUV = project(model * pos) → 0..1
vec3 flow = vec3(texture(fluidVelocity, screenUV).xy, 0.0) rotated by the camera's world rotation
pos += flow * 0.0001 * HZ * 0.4 * texture(fluidDensity, screenUV).r;  // uMouseStrength 0.4
```

**形状。** 平滑、有机的雕塑形体，尺寸约 0.7 单位：一个弯曲的空心环 / 类环面团块，有一个大开口和较柔和的分叶，用有符号距离函数（SDF）定义。原作用一个小型 sine-network SDF；任何闭合、平滑、略带扭转、有一个大孔的环都能达到相同观感。求值前先镜像深度轴：`p.z = sqrt(p.z*p.z + 0.0215) - sqrt(0.012)`，使形体前后对称、接缝柔和；再用四元数 (0.5, 0.5, 0.5, 0.5) 旋转 `p`。半径 0.8 以外返回 `length(p) - 0.7`。

**Curl noise。** 三个 sine-sum 势函数的解析旋度（Bridson 方法），并归一化。

**点渲染。** 加法混合，transparent，开启深度测试，关闭深度写入。
- 顶点：`pos *= mix(1.0, 1.5, pow(random.y, 150.0))`；`scale = smoothstep(3, 15, distToCamera) * mix(0.5, 1.0, random.z)`；`gl_PointSize = 0.04 * DPR * 2.0 * scale * (1000 / viewDistance)`。
- 片元：圆外 discard；scale < 0.1 时 discard；基础色为灰度 `mix(0.0, 0.2, random.x)`，按 `pow(random.z, 100)` 混向薰衣草紫 (0.6, 0.45, 1.0)；闪烁 `0.5 + (0.4 + sin(time*4 + random.y*20)) * pow(random.z, 10) * 2.5`；matcap 用旋转后的 sprite UV 采样（旋转量 `sin(time + random.z*20)*0.5 + 1`），先以 0.8 做 soft-light 混合，再以 0.2 做 overlay；alpha 1。

## 8. 流体模拟（驱动鼠标交互）

经典 GPU 流体（curl → vorticity → divergence → pressure → gradient subtract → advect velocity → advect density → display），半精度浮点 ping-pong 渲染目标。

| 设置 | 值 |
| --- | --- |
| Sim resolution | 256 × 256 |
| Dye resolution | 512 × 512 |
| Velocity dissipation | 0.98 |
| Density dissipation | 0.97 |
| Pressure dissipation | 0.95 |
| Pressure iterations | 5 |
| Curl | 30 |
| dt | 1/60 |

**每帧鼠标输入。** `len` = 光标自上一帧移动的距离（px）。Splat 半径 = clamp-map(len, 0..5 → 0..60) × 0.6（移动端再 × 0.8）；力度倍数 = clamp-map(len, 0..15 → 0..10)。当 len > 0.01 时：从上一点到当前点画一条 splat 线，向速度场叠加颜色 (dx × mult, -dy × mult, 1)，向密度场写入白色，半径为 radius/200（UV 单位，按宽高比校正）。距上次 splat 超过 50 ms 时，线从当前点开始。

密度纹理渲染到一个视口大小的目标（alpha = max(r, g, b)），作为遮罩，把推力限制在光标经过的区域。

## 9. 交互与动效

- 光标在任意位置移动：流体 splat → 粒子沿流动旋转漂移，然后在约 1–2 秒内恢复到形体上。
- 光标移动也会让相机轻微平移（注视相机）。
- 触摸：`touchstart` / `touchmove` 写入同一个鼠标位置。
- 窗口缩放：renderer、相机宽高比和流体遮罩目标跟随窗口。
- 链接：悬停 300 ms 渐变到 70%。
- 没有入场动画；点云在模拟的前约 3 秒内从随机位置成形。

## 10. 原说明的验收要点（EvoScholar 版见视觉方案 §8）

- 黑底、无滚动条，canvas 在任意尺寸下铺满视口。
- 白灰色为主、零星紫色点的密集点云，构成一个空心、扭转的环形，位置在 UI 列的略偏右处。
- 光标划过点云时明显被搅动，2 秒内恢复。
- 相机随光标轻微漂移。
- 标题用 #aa88ff；文字在粒子上加法混合发光；卡片不透明。
- 宽度低于 760 px 时隐藏 chip 和卡片列，文字列移到底部。
- 控制台无报错。
