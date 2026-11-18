// Numeric parameters of the background layer. Particle / fluid / camera values follow
// docs/axon-reference.md §7–§8; EvoScholar state mappings follow docs/frontend-visual-plan.md §5.
export const CONFIG = {
  camera: { fov: 30, near: 0.1, far: 1000, base: [-1.17, 0, 6], gazeX: -1, gazeY: 2, lerp: 0.05 },
  group: { position: [0.343, 0.16, -1], rotationDeg: [-28.4, 390, 4.92], scale: [5, 5, 6] },
  particles: {
    curlNoiseScale: 1, curlTimeScale: 0.5, curlNoiseSpeed: 1,
    swirl: 0.0005, surfacePull: 0.5, originSpring: 0.0002, mouseStrength: 0.4,
    pointSize: 0.04, purple: [0.6, 0.45, 1.0]
  },
  fluid: {
    simResolution: 256, dyeResolution: 512,
    velocityDissipation: 0.98, densityDissipation: 0.97, pressureDissipation: 0.95,
    pressureIterations: 5, curl: 30, dt: 1 / 60
  },
  // simulation texture edge → point count: 512² = 262,144; 256² = 65,536; 128² = 16,384
  quality: { high: 512, mid: 256, low: 128, off: 0 },
  states: {
    idle: { curlMul: 1.0, purpleExp: 100, twinkle: 1.0, purpleTint: 0.0, breathe: 0.0 },
    thinking: { curlMul: 2.5, purpleExp: 100, twinkle: 1.0, purpleTint: 0.0, breathe: 0.06 },
    tool: { curlMul: 1.6, purpleExp: 30, twinkle: 2.0, purpleTint: 0.0, breathe: 0.0 },
    approval: { curlMul: 1.0, purpleExp: 100, twinkle: 1.0, purpleTint: 0.2, breathe: 0.03 }
  },
  dimMs: 600,
  typingMouseStrength: 0.15,
  pauseAfterHiddenMs: 30000,
  maxHZ: 3,
  warmGray: [1.0, 0.9, 0.78],
  danger: [1.0, 0.42, 0.42]
}
