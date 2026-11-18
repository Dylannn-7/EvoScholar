// GPU particle cloud: position ping-pong simulation (curl noise + SDF surface + spring to origin
// + mouse fluid) and additive point rendering with a procedural matcap.
import * as THREE from '../vendor/three.module.js'
import { CONFIG } from './config.js'

// Open, twisted ring with two soft lobes (our own shape; the reference only fixes the
// mirroring and the quaternion rotation applied before evaluation).
const SDF = /* glsl */ `
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float angDist(float a, float b) { float d = mod(a - b + 3.14159265, 6.2831853) - 3.14159265; return abs(d); }
const float SHAPE_SCALE = 1.2;   // the unit design below drawn at 1/SHAPE_SCALE: a large ring that fills the view
mat2 rot2(float t) { return mat2(cos(t), -sin(t), sin(t), cos(t)); }
float sdfShape(vec3 p) {
  p.z = sqrt(p.z * p.z + 0.0215) - sqrt(0.012);
  p = qrot(vec4(0.5, 0.5, 0.5, 0.5), p);
  if (length(p) > 0.8) return length(p) - 0.7;
  p *= SHAPE_SCALE;
  p = p.yzx;                                                        // ring faces the camera after the group rotation
  float a = atan(p.y, p.x);
  float r = length(p.xy);
  float R = 0.40 + 0.035 * sin(a * 2.0 + 0.4);                     // organic, slightly oval centreline
  vec2 q = rot2(a * 0.5) * vec2(r - R, p.z);                        // half twist along the ring
  float thick = 0.165 + 0.045 * sin(a * 3.0 + 0.7) + 0.025 * sin(a * 5.0 + 1.9);
  thick *= 1.0 - 0.5 * (1.0 - smoothstep(0.0, 1.0, angDist(a, 2.35)));   // one shallow pinch
  float ring = length(q * vec2(1.0, 1.3)) - thick;
  float lobe1 = length(p - vec3(0.40 * cos(-0.9), 0.40 * sin(-0.9), 0.04)) - 0.19;
  float lobe2 = length(p - vec3(0.42 * cos(0.95), 0.42 * sin(0.95), -0.05)) - 0.15;
  return smin(smin(ring, lobe1, 0.16), lobe2, 0.14) / SHAPE_SCALE;
}
vec3 sdfNormal(vec3 p) {
  const vec2 e = vec2(0.001, 0.0);
  return vec3(sdfShape(p + e.xyy) - sdfShape(p - e.xyy), sdfShape(p + e.yxy) - sdfShape(p - e.yxy), sdfShape(p + e.yyx) - sdfShape(p - e.yyx)) / (2.0 * e.x);
}
// Curl of three sine-sum potentials (finite differences), normalised.
vec3 potential(vec3 p) {
  p *= 4.0;
  return vec3(sin(p.y * 1.7 + cos(p.z * 1.3)) + sin(p.z * 2.3 + 0.5),
              sin(p.z * 1.9 + cos(p.x * 1.1)) + sin(p.x * 2.1 + 1.3),
              sin(p.x * 1.5 + cos(p.y * 1.7)) + sin(p.y * 2.7 + 2.1));
}
vec3 curlNoise(vec3 p) {
  const float e = 0.01;
  vec3 dx = (potential(p + vec3(e, 0, 0)) - potential(p - vec3(e, 0, 0))) / (2.0 * e);
  vec3 dy = (potential(p + vec3(0, e, 0)) - potential(p - vec3(0, e, 0))) / (2.0 * e);
  vec3 dz = (potential(p + vec3(0, 0, e)) - potential(p - vec3(0, 0, e))) / (2.0 * e);
  vec3 c = vec3(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x);
  return c / (length(c) + 1e-5);
}`

const SIM_VERT = `varying vec2 vUv; void main () { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`
const SIM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uPos; uniform sampler2D uOrigin; uniform sampler2D uFluidVel; uniform sampler2D uFluidDen;
uniform float uTime; uniform float uHZ; uniform float uCurlMul; uniform float uMouse;
uniform float uCurlScale; uniform float uCurlTime; uniform float uCurlSpeed; uniform float uSwirl; uniform float uPull; uniform float uSpring;
uniform mat4 uProj; uniform mat4 uModel; uniform mat3 uCamRot;
${SDF}
void main () {
  vec3 pos = texture2D(uPos, vUv).xyz;
  vec3 origin = texture2D(uOrigin, vUv).xyz;
  if (any(isnan(pos)) || any(isinf(pos)) || length(pos) > 50.0) pos = origin;   // never lose a particle
  if (length(pos) > 0.7) pos /= 2.0;
  pos += curlNoise(pos * 0.1 * uCurlScale + uTime * 0.1 * uCurlTime) * uCurlSpeed * 0.0002 * uHZ * uCurlMul;
  vec3 g = sdfNormal(pos);
  float d = sdfShape(pos);
  pos += cross(normalize(pos + 1e-5), normalize(g + 1e-5)) * uSwirl;
  pos += -g * d * uPull;
  pos += (origin - pos) * uSpring * uHZ;
  vec4 clip = uProj * uModel * vec4(pos, 1.0);
  vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
  if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
    vec2 v = clamp(texture2D(uFluidVel, suv).xy, vec2(-1000.0), vec2(1000.0));
    vec3 flow = uCamRot * vec3(v, 0.0);
    float den = clamp(texture2D(uFluidDen, suv).r, 0.0, 1.0);
    if (!any(isnan(flow))) pos += flow * 0.0001 * uHZ * uMouse * den;
  }
  gl_FragColor = vec4(pos, 1.0);
}`

const POINT_VERT = /* glsl */ `
uniform sampler2D uPos; uniform float uDPR; uniform float uSize; uniform float uBreathe; uniform float uTime;
attribute vec4 random;
varying vec4 vRandom; varying float vScale;
void main () {
  vec3 p = texture2D(uPos, position.xy).xyz;
  p *= mix(1.0, 1.5, pow(random.y, 150.0));
  p *= 1.0 + uBreathe * sin(uTime * 2.0 + random.x * 0.6);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  float scale = smoothstep(3.0, 15.0, dist) * mix(0.5, 1.0, random.z);
  gl_PointSize = uSize * uDPR * 2.0 * scale * (1000.0 / dist) / 18.0;
  vScale = scale; vRandom = random;
  gl_Position = projectionMatrix * mv;
}`

const POINT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMatcap; uniform float uTime; uniform float uDim; uniform float uPurpleExp; uniform float uTwinkle; uniform float uPurpleTint;
uniform vec3 uPurple; uniform vec3 uTint;
varying vec4 vRandom; varying float vScale;
vec3 softLight(vec3 a, vec3 b) { return mix(2.0 * a * b + a * a * (1.0 - 2.0 * b), sqrt(a) * (2.0 * b - 1.0) + 2.0 * a * (1.0 - b), step(0.5, b)); }
vec3 overlay(vec3 a, vec3 b) { return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a)); }
void main () {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  if (dot(c, c) > 1.0 || vScale < 0.1) discard;
  vec3 col = vec3(mix(0.0, 0.2, vRandom.x)) * uTint;
  col = mix(col, uPurple, pow(vRandom.z, uPurpleExp));
  col *= 0.5 + (0.4 + sin(uTime * 4.0 * uTwinkle + vRandom.y * 20.0)) * pow(vRandom.z, 10.0) * 2.5;
  float ang = sin(uTime + vRandom.z * 20.0) * 0.5 + 1.0;
  vec2 muv = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * c * 0.5 + 0.5;
  vec3 m = texture2D(uMatcap, muv).rgb;
  col = mix(col, softLight(col, m), 0.8);
  col = mix(col, overlay(col, m), 0.2);
  col = mix(col, col * uPurple * 1.6, uPurpleTint);
  gl_FragColor = vec4(col * uDim, 1.0);
}`

function matcap () {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 64
  const g = cv.getContext('2d')
  const grad = g.createRadialGradient(24, 22, 2, 32, 32, 34)
  grad.addColorStop(0, '#f2f2f2')
  grad.addColorStop(0.45, '#9a9a9a')
  grad.addColorStop(1, '#1a1a1a')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(cv)
}

function randomPositions (n) {
  const a = new Float32Array(n * n * 4)
  for (let i = 0; i < n * n; i++) {
    a[i * 4] = Math.random() * 2 - 1
    a[i * 4 + 1] = Math.random() * 2 - 1
    a[i * 4 + 2] = Math.random() * 2 - 1
    a[i * 4 + 3] = 1
  }
  return a
}

export class Particles {
  constructor (renderer, size, floatType) {
    this.renderer = renderer
    this.size = size
    const n = size
    const opts = { type: floatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false }
    this.read = new THREE.WebGLRenderTarget(n, n, opts)
    this.write = new THREE.WebGLRenderTarget(n, n, opts)
    this.originTex = new THREE.DataTexture(randomPositions(n), n, n, THREE.RGBAFormat, THREE.FloatType)
    this.originTex.needsUpdate = true
    const p = CONFIG.particles
    this.simMat = new THREE.ShaderMaterial({
      vertexShader: SIM_VERT, fragmentShader: SIM_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        uPos: { value: null }, uOrigin: { value: this.originTex }, uFluidVel: { value: null }, uFluidDen: { value: null },
        uTime: { value: 0 }, uHZ: { value: 1 }, uCurlMul: { value: 1 }, uMouse: { value: p.mouseStrength },
        uCurlScale: { value: p.curlNoiseScale }, uCurlTime: { value: p.curlTimeScale }, uCurlSpeed: { value: p.curlNoiseSpeed },
        uSwirl: { value: p.swirl }, uPull: { value: p.surfacePull }, uSpring: { value: p.originSpring },
        uProj: { value: new THREE.Matrix4() }, uModel: { value: new THREE.Matrix4() }, uCamRot: { value: new THREE.Matrix3() }
      }
    })
    this.copyMat = new THREE.MeshBasicMaterial({ map: this.originTex })
    this.simScene = new THREE.Scene()
    this.simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.simMat)
    this.simScene.add(this.quad)
    this.seed()

    const count = n * n
    const uv = new Float32Array(count * 3)
    const rnd = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) {
      uv[i * 3] = ((i % n) + 0.5) / n
      uv[i * 3 + 1] = (Math.floor(i / n) + 0.5) / n
      for (let k = 0; k < 4; k++) rnd[i * 4 + k] = Math.random()
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(uv, 3))
    geo.setAttribute('random', new THREE.BufferAttribute(rnd, 4))
    this.pointMat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, transparent: true, depthTest: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPos: { value: this.read.texture }, uDPR: { value: Math.min(window.devicePixelRatio || 1, 2) }, uSize: { value: p.pointSize * 18 * p.sizeMul },
        uTime: { value: 0 }, uMatcap: { value: matcap() }, uDim: { value: 1 }, uPurpleExp: { value: 100 }, uTwinkle: { value: 1 },
        uPurpleTint: { value: 0 }, uBreathe: { value: 0 }, uPurple: { value: new THREE.Color(...p.purple) }, uTint: { value: new THREE.Color(1, 1, 1) }
      }
    })
    this.points = new THREE.Points(geo, this.pointMat)
    this.points.frustumCulled = false
  }

  /** Copy the origin texture into the position target (initial state and "reform"). */
  seed () {
    this.quad.material = this.copyMat
    for (const t of [this.read, this.write]) {
      this.renderer.setRenderTarget(t)
      this.renderer.render(this.simScene, this.simCam)
    }
    this.renderer.setRenderTarget(null)
    this.quad.material = this.simMat
  }

  /** New random origins: the cloud scatters and re-forms over a few seconds. */
  reform () {
    this.originTex.image.data.set(randomPositions(this.size))
    this.originTex.needsUpdate = true
    this.seed()
  }

  step ({ time, hz, fluid, camera, group }) {
    const u = this.simMat.uniforms
    u.uPos.value = this.read.texture
    u.uTime.value = time
    u.uHZ.value = hz
    u.uFluidVel.value = fluid ? fluid.velocityTexture : null
    u.uFluidDen.value = fluid ? fluid.densityTexture : null
    u.uProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    u.uModel.value.copy(group.matrixWorld)
    u.uCamRot.value.setFromMatrix4(camera.matrixWorld)
    this.quad.material = this.simMat
    this.renderer.setRenderTarget(this.write)
    this.renderer.render(this.simScene, this.simCam)
    this.renderer.setRenderTarget(null)
    const t = this.read; this.read = this.write; this.write = t
    this.pointMat.uniforms.uPos.value = this.read.texture
    this.pointMat.uniforms.uTime.value = time
  }

  dispose () {
    this.read.dispose(); this.write.dispose(); this.originTex.dispose()
    this.simMat.dispose(); this.pointMat.dispose(); this.points.geometry.dispose()
  }
}
