// Background layer: particle cloud + mouse fluid. The workbench only talks to it through the
// small API returned by initFx(); if WebGL2 / float render targets are missing it degrades to
// a static background and every method becomes a no-op.
import * as THREE from '../vendor/three.module.js'
import { CONFIG } from './config.js'
import { Fluid } from './fluid.js'
import { Particles } from './particles.js'

const NOOP = { setState () {}, setDim () {}, setBudgetLevel () {}, reform () {}, setQuality () {}, setMouseStrength () {}, setPaused () {}, setShape () {}, pulse () {}, setFocus () {}, quality: 'off', dispose () {} }
const QKEY = 'evoscholar.fxQuality'

function autoQuality () {
  const mobile = matchMedia('(pointer: coarse)').matches || innerWidth < 760
  if (mobile) return 'low'
  if ((navigator.hardwareConcurrency || 8) <= 4) return 'mid'
  return 'high'
}

export function storedQuality () {
  try { return localStorage.getItem(QKEY) || 'auto' } catch { return 'auto' }
}

export function initFx (canvas) {
  const pref = storedQuality()
  const quality = pref === 'auto' ? autoQuality() : pref
  document.body.classList.remove('fx-off')
  if (quality === 'off') { document.body.classList.add('fx-off'); return { ...NOOP, quality } }
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' })
  } catch {
    document.body.classList.add('fx-off')
    return NOOP
  }
  const life = new AbortController()
  const gl = renderer.getContext()
  const floatOk = renderer.capabilities.isWebGL2 && !!renderer.extensions.get('EXT_color_buffer_float')
  if (!floatOk) { renderer.dispose(); document.body.classList.add('fx-off'); return NOOP }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
  renderer.setClearColor(0x000000, 1)
  renderer.setSize(innerWidth, innerHeight, false)

  const C = CONFIG
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(C.camera.fov, innerWidth / innerHeight, C.camera.near, C.camera.far)
  const base = new THREE.Vector3(...C.camera.base)
  camera.position.copy(base)
  camera.lookAt(0, 0, 0)
  const group = new THREE.Group()
  group.position.set(...C.group.position)
  group.rotation.set(...C.group.rotationDeg.map((d) => THREE.MathUtils.degToRad(d)))
  group.scale.set(...C.group.scale)
  scene.add(group)

  const size = C.quality[quality]
  const particles = new Particles(renderer, size, THREE.FloatType)
  group.add(particles.points)
  const fluid = new Fluid(renderer, THREE.HalfFloatType)

  // ---- state (targets are approached smoothly each frame)
  const cur = { ...C.states.idle, dim: 1, mouse: C.particles.mouseStrength, tint: new THREE.Color(1, 1, 1), purple: new THREE.Color(...C.particles.purple) }
  let target = { ...C.states.idle }
  let dimTarget = 1
  let mouseTarget = C.particles.mouseStrength
  let budget = 0
  // chain-of-thought shape and transient effects
  let shapeId = 0
  let morph = 0
  let morphTarget = 0
  let contractUntil = 0
  let contract = 0
  const pulse = { t0: -1e9, ms: 1, color: new THREE.Color() }
  let focusX = 0.6
  const ndc = new THREE.Vector3()
  const ray = new THREE.Vector3()

  // ---- input
  const mouse = { x: innerWidth / 2, y: innerHeight / 2, px: null, py: null, last: 0 }
  const move = (x, y) => { mouse.x = x; mouse.y = y }
  addEventListener('mousemove', (e) => move(e.clientX, e.clientY), { passive: true, signal: life.signal })
  addEventListener('touchstart', (e) => { const t = e.touches[0]; if (t) { move(t.clientX, t.clientY); mouse.px = t.clientX; mouse.py = t.clientY } }, { passive: true, signal: life.signal })
  addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY) }, { passive: true, signal: life.signal })
  const mobile = matchMedia('(pointer: coarse)').matches
  const clampMap = (v, a, b, c, d) => c + (d - c) * Math.min(1, Math.max(0, (v - a) / (b - a)))

  function feedMouse (now) {
    if (mouse.px === null) { mouse.px = mouse.x; mouse.py = mouse.y }
    const dx = mouse.x - mouse.px
    const dy = mouse.y - mouse.py
    const len = Math.hypot(dx, dy)
    if (len > 0.01 && now - mouse.last > 50) {
      // more than 50 ms since the last splat: the line starts at the current point
      mouse.last = now
    } else if (len > 0.01) {
      const radius = clampMap(len, 0, 5, 0, 60) * 0.6 * (mobile ? 0.8 : 1)
      const mult = clampMap(len, 0, 15, 0, 10)
      const steps = Math.min(8, Math.max(1, Math.ceil(len / 12)))
      const aspect = innerWidth / innerHeight
      for (let i = 1; i <= steps; i++) {
        const x = mouse.px + (dx * i) / steps
        const y = mouse.py + (dy * i) / steps
        fluid.splat(x / innerWidth, 1 - y / innerHeight, (dx * mult) / steps, (-dy * mult) / steps, Math.max(radius, 1) / 200, aspect)
      }
      mouse.last = now
    }
    mouse.px = mouse.x
    mouse.py = mouse.y
  }

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight, false)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  }, { signal: life.signal })

  // ---- loop
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  let running = true
  let userPaused = false
  let raf = 0
  let hiddenSince = 0
  let lastT = performance.now()
  let simTime = 0

  function frame (now) {
    const dt = Math.max(0, now - lastT)
    lastT = now
    const hz = Math.min(C.maxHZ, (dt / 1000) * 60 || 1)
    simTime += dt / 1000
    const k = 1 - Math.pow(1 - 0.06, hz)
    for (const key of ['curlMul', 'purpleExp', 'twinkle', 'purpleTint', 'breathe', 'swirl', 'blink']) cur[key] += ((target[key] ?? 0) - (cur[key] ?? 0)) * k
    morph += (morphTarget - morph) * (1 - Math.pow(1 - 0.035, hz))
    contract += ((now < contractUntil ? 1 : 0) - contract) * (1 - Math.pow(1 - 0.12, hz))
    cur.dim += (dimTarget - cur.dim) * Math.min(1, dt / C.dimMs * 3)
    cur.mouse += (mouseTarget - cur.mouse) * k

    // gaze camera
    const mx = (mouse.x / innerWidth) * 2 - 1
    const my = (mouse.y / innerHeight) * 2 - 1
    const goal = base.clone().add(new THREE.Vector3(mx * C.camera.gazeX, my * C.camera.gazeY, 0))
    camera.position.lerp(goal, C.camera.lerp)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    group.updateMatrixWorld()

    feedMouse(now)
    fluid.step()
    particles.simMat.uniforms.uCurlMul.value = cur.curlMul
    particles.simMat.uniforms.uSwirlMul.value = cur.swirl ?? 1
    particles.simMat.uniforms.uShape.value = shapeId
    particles.simMat.uniforms.uMorph.value = morph
    particles.simMat.uniforms.uContract.value = contract
    // shapes centre on the conversation column: unproject its screen centre onto the group's depth plane
    ndc.set(focusX * 2 - 1, 0.08, 0.5).unproject(camera)
    ray.copy(ndc).sub(camera.position).normalize()
    const tHit = (group.position.z - camera.position.z) / ray.z
    particles.simMat.uniforms.uCenter.value.copy(camera.position).addScaledVector(ray, tHit)
    particles.pointMat.uniforms.uShapeDim.value = 1 - 0.3 * morph
    particles.simMat.uniforms.uMouse.value = cur.mouse
    particles.step({ time: simTime, hz, fluid, camera, group })
    const pu = particles.pointMat.uniforms
    const blink = (cur.blink ?? 0) * (0.5 + 0.5 * Math.sin(simTime * 2.4))
    pu.uDim.value = cur.dim * (1 - 0.35 * blink)
    const pt = (now - pulse.t0) / pulse.ms
    pu.uPulseR.value = 0.02 + pt * 0.6
    pu.uPulseA.value = pt >= 0 && pt < 1 ? Math.sin(pt * Math.PI) * 0.9 : 0
    pu.uPulseColor.value.copy(pulse.color)
    pu.uPurpleExp.value = cur.purpleExp
    pu.uTwinkle.value = cur.twinkle
    pu.uPurpleTint.value = cur.purpleTint
    pu.uBreathe.value = cur.breathe
    // budget: warm the base grey above 80 %; purple turns to danger red when over the soft cap
    const warm = THREE.MathUtils.clamp((budget - 0.8) / 0.2, 0, 1)
    pu.uTint.value.setRGB(1 + (C.warmGray[0] - 1) * warm, 1 + (C.warmGray[1] - 1) * warm, 1 + (C.warmGray[2] - 1) * warm)
    pu.uPurple.value.setRGB(...(budget >= 1 ? C.danger : C.particles.purple))
    renderer.setRenderTarget(null)
    renderer.render(scene, camera)
    if (running && !reduced) raf = requestAnimationFrame(frame)
  }

  if (reduced) {
    // static frame: let the cloud form, then render once
    for (let i = 0; i < 240; i++) { simTime += 1 / 60; particles.step({ time: simTime, hz: 1, fluid: null, camera, group: (group.updateMatrixWorld(), group) }) }
    frame(performance.now())
  } else {
    raf = requestAnimationFrame(frame)
  }

  document.addEventListener('visibilitychange', () => {
    if (reduced) return
    if (document.hidden) {
      hiddenSince = performance.now()
      setTimeout(() => { if (document.hidden && performance.now() - hiddenSince >= C.pauseAfterHiddenMs) { running = false; cancelAnimationFrame(raf) } }, C.pauseAfterHiddenMs + 50)
    } else if (!running && !userPaused) {
      running = true
      lastT = performance.now()
      raf = requestAnimationFrame(frame)
    }
  }, { signal: life.signal })

  return {
    quality,
    setState (s) { target = { ...(C.states[s] || C.states.idle) } },
    setDim (v) { dimTarget = Math.max(0, Math.min(1, v)) },
    setBudgetLevel (v) { budget = Math.max(0, v || 0) },
    setMouseStrength (v) { mouseTarget = v ?? C.particles.mouseStrength },
    setPaused (p) {
      userPaused = !!p
      if (userPaused) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!running && !reduced && !document.hidden) {
        running = true
        lastT = performance.now()
        raf = requestAnimationFrame(frame)
      }
    },
    reform () { particles.reform() },
    /** Horizontal screen position (0..1) the shapes centre on, e.g. the conversation column. */
    setFocus (x) { focusX = Math.min(0.9, Math.max(0.1, x)) },
    /** Morph toward a chain-of-thought shape: ring | constellation | curve | stripes. */
    setShape (name) {
      const id = C.shapes[name] ?? 0
      if (id === 0) { morphTarget = 0; return }
      shapeId = id
      morphTarget = 1
    },
    /** Transient effects: reflect (draw in, then re-form), evolve (purple ripple), deliver (white ripple). */
    pulse (kind) {
      const now = performance.now()
      if (kind === 'reflect') { contractUntil = now + C.pulse.reflectMs; return }
      pulse.t0 = now
      pulse.ms = kind === 'deliver' ? C.pulse.deliverMs : C.pulse.evolveMs
      pulse.color.setRGB(...(kind === 'deliver' ? C.pulse.deliverColor : C.pulse.evolveColor))
    },
    setQuality (q) { try { localStorage.setItem(QKEY, q) } catch {} },
    dispose () { life.abort(); running = false; cancelAnimationFrame(raf); particles.dispose(); fluid.dispose(); renderer.dispose() }
  }
}
