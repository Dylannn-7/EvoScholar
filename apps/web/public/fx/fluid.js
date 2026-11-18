// GPU fluid driving the mouse interaction: curl → vorticity → divergence → pressure (Jacobi)
// → gradient subtract → advect velocity → advect density. Half-float ping-pong targets.
import * as THREE from '../vendor/three.module.js'
import { CONFIG } from './config.js'

const VERT = /* glsl */ `
varying vec2 vUv;
varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
uniform vec2 texelSize;
void main () {
  vUv = position.xy * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0); vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y); vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`

const FRAG = {
  splat: `
    precision highp float; varying vec2 vUv;
    uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius;
    void main () {
      vec2 p = vUv - point; p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / (radius * radius)) * color;
      gl_FragColor = vec4(clamp(texture2D(uTarget, vUv).xyz + splat, vec3(-1000.0), vec3(1000.0)), 1.0);
    }`,
  curl: `
    precision highp float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).y; float R = texture2D(uVelocity, vR).y;
      float T = texture2D(uVelocity, vT).x; float B = texture2D(uVelocity, vB).x;
      gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`,
  vorticity: `
    precision highp float; varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;
    void main () {
      float L = texture2D(uCurl, vL).x; float R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x; float B = texture2D(uCurl, vB).x; float C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001; force *= curl * C; force.y *= -1.0;
      vec2 vel = texture2D(uVelocity, vUv).xy + force * dt;
      gl_FragColor = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
    }`,
  divergence: `
    precision highp float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).x; float R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y; float B = texture2D(uVelocity, vB).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vL.x < 0.0) { L = -C.x; } if (vR.x > 1.0) { R = -C.x; }
      if (vT.y > 1.0) { T = -C.y; } if (vB.y < 0.0) { B = -C.y; }
      gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`,
  clear: `
    precision highp float; varying vec2 vUv; uniform sampler2D uTexture; uniform float value;
    void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`,
  pressure: `
    precision highp float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uPressure; uniform sampler2D uDivergence;
    void main () {
      float L = texture2D(uPressure, vL).x; float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x; float B = texture2D(uPressure, vB).x;
      float div = texture2D(uDivergence, vUv).x;
      gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
    }`,
  gradient: `
    precision highp float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uPressure; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uPressure, vL).x; float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x; float B = texture2D(uPressure, vB).x;
      vec2 vel = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
      gl_FragColor = vec4(clamp(vel, vec2(-1000.0), vec2(1000.0)), 0.0, 1.0);
    }`,
  advection: `
    precision highp float; varying vec2 vUv;
    uniform sampler2D uVelocity; uniform sampler2D uSource; uniform vec2 texelSize; uniform float dt; uniform float dissipation;
    void main () {
      vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
      vec4 v = dissipation * texture2D(uSource, coord);
      gl_FragColor = clamp(v, vec4(-1000.0), vec4(1000.0));
    }`
}

function target (w, h, type) {
  return new THREE.WebGLRenderTarget(w, h, {
    type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping
  })
}
function pair (w, h, type) {
  const p = { read: target(w, h, type), write: target(w, h, type) }
  p.swap = () => { const t = p.read; p.read = p.write; p.write = t }
  return p
}

export class Fluid {
  constructor (renderer, type) {
    this.renderer = renderer
    const c = CONFIG.fluid
    this.sim = c.simResolution
    this.dye = c.dyeResolution
    this.velocity = pair(this.sim, this.sim, type)
    this.density = pair(this.dye, this.dye, type)
    this.pressure = pair(this.sim, this.sim, type)
    this.divergence = target(this.sim, this.sim, type)
    this.curl = target(this.sim, this.sim, type)
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
    this.scene.add(this.quad)
    this.mats = {}
    for (const [k, frag] of Object.entries(FRAG)) {
      this.mats[k] = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false,
        uniforms: { texelSize: { value: new THREE.Vector2(1 / this.sim, 1 / this.sim) } }
      })
    }
    this.splats = []
  }

  pass (name, uniforms, out) {
    const m = this.mats[name]
    for (const [k, v] of Object.entries(uniforms)) {
      if (!m.uniforms[k]) m.uniforms[k] = { value: v }
      else m.uniforms[k].value = v
    }
    this.quad.material = m
    this.renderer.setRenderTarget(out)
    this.renderer.render(this.scene, this.camera)
  }

  /** Queue a splat in UV space: dx, dy in pixels × multiplier; radius in UV units. */
  splat (x, y, dx, dy, radius, aspect) {
    this.splats.push({ x, y, dx, dy, radius, aspect })
  }

  step () {
    const c = CONFIG.fluid
    const simTexel = new THREE.Vector2(1 / this.sim, 1 / this.sim)
    for (const s of this.splats.splice(0)) {
      this.pass('splat', { uTarget: this.velocity.read.texture, aspectRatio: s.aspect, point: new THREE.Vector2(s.x, s.y), color: new THREE.Vector3(s.dx, s.dy, 1), radius: s.radius }, this.velocity.write)
      this.velocity.swap()
      this.pass('splat', { uTarget: this.density.read.texture, aspectRatio: s.aspect, point: new THREE.Vector2(s.x, s.y), color: new THREE.Vector3(1, 1, 1), radius: s.radius }, this.density.write)
      this.density.swap()
    }
    this.pass('curl', { uVelocity: this.velocity.read.texture, texelSize: simTexel }, this.curl)
    this.pass('vorticity', { uVelocity: this.velocity.read.texture, uCurl: this.curl.texture, curl: c.curl, dt: c.dt, texelSize: simTexel }, this.velocity.write)
    this.velocity.swap()
    this.pass('divergence', { uVelocity: this.velocity.read.texture, texelSize: simTexel }, this.divergence)
    this.pass('clear', { uTexture: this.pressure.read.texture, value: c.pressureDissipation }, this.pressure.write)
    this.pressure.swap()
    for (let i = 0; i < c.pressureIterations; i++) {
      this.pass('pressure', { uPressure: this.pressure.read.texture, uDivergence: this.divergence.texture, texelSize: simTexel }, this.pressure.write)
      this.pressure.swap()
    }
    this.pass('gradient', { uPressure: this.pressure.read.texture, uVelocity: this.velocity.read.texture, texelSize: simTexel }, this.velocity.write)
    this.velocity.swap()
    this.pass('advection', { uVelocity: this.velocity.read.texture, uSource: this.velocity.read.texture, texelSize: simTexel, dt: c.dt, dissipation: c.velocityDissipation }, this.velocity.write)
    this.velocity.swap()
    this.pass('advection', { uVelocity: this.velocity.read.texture, uSource: this.density.read.texture, texelSize: simTexel, dt: c.dt, dissipation: c.densityDissipation }, this.density.write)
    this.density.swap()
    this.renderer.setRenderTarget(null)
  }

  get velocityTexture () { return this.velocity.read.texture }
  get densityTexture () { return this.density.read.texture }

  dispose () {
    for (const t of [this.velocity.read, this.velocity.write, this.density.read, this.density.write, this.pressure.read, this.pressure.write, this.divergence, this.curl]) t.dispose()
    for (const m of Object.values(this.mats)) m.dispose()
  }
}
