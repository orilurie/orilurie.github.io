// צוללות – the 3D battle scene (three.js): a Gerstner-wave ocean at dusk, two grids on the
// water, procedural warships that ride the waves, missiles, explosions, splashes, fire and
// sinking ships. The game logic lives elsewhere; this module only draws and reports taps.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const SIZE = 10;
// Grid origins (top-left cell corner) in world space. The player's own waters are nearer the camera.
const GRIDS = { enemy: { ox: -5, oz: -13 }, mine: { ox: -5, oz: 2 } };
const GRID_Y = 0.14; // just above the calmed waves, below the ships' decks
const WRECK_Y = -0.12; // how low a sunk ship rests (deck just above the water)
const SUN_DIR = new THREE.Vector3(-0.35, 0.22, -1).normalize();

// ---------- waves (same formula in the shader and on the CPU, so ships ride the water) ----------
const WAVES = [
  // dirX, dirZ, steepness, wavelength
  [1.0, 0.35, 0.075, 9.0],
  [0.55, 1.0, 0.06, 6.0],
  [-0.45, 0.8, 0.05, 4.2],
  [0.25, -0.9, 0.035, 2.6],
];
const TIME_SCALE = 0.55;
// The sea is calmer over the two boards (so ships aren't swamped by crests) and rougher
// around them. Same function in the shader below.
const CALM = 0.4, FEATHER = 2;
const smooth = (a, b, x) => { const k = Math.min(Math.max((x - a) / (b - a), 0), 1); return k * k * (3 - 2 * k); };
function calm(x, z) {
  let inside = 0;
  for (const g of Object.values(GRIDS)) {
    const r = smooth(g.ox - FEATHER, g.ox, x) * (1 - smooth(g.ox + 10, g.ox + 10 + FEATHER, x))
      * smooth(g.oz - FEATHER, g.oz, z) * (1 - smooth(g.oz + 10, g.oz + 10 + FEATHER, z));
    inside = Math.max(inside, r);
  }
  return 1 - (1 - CALM) * inside;
}
export function waveHeight(x, z, t) {
  const amp = calm(x, z);
  let y = 0;
  for (const [dx, dz, s, len] of WAVES) {
    const k = (2 * Math.PI) / len, c = Math.sqrt(9.8 / k), l = Math.hypot(dx, dz);
    const f = k * ((dx / l) * x + (dz / l) * z - c * t * TIME_SCALE);
    y += (s * amp / k) * Math.sin(f);
  }
  return y;
}

const WATER_VERT = /* glsl */`
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vHeight;
const int N = ${WAVES.length};
uniform vec4 uWaves[N];
uniform vec4 uGrids[2]; // ox, oz of each board
float boardMask(vec2 p, vec4 g) {
  float f = ${FEATHER.toFixed(1)};
  return smoothstep(g.x - f, g.x, p.x) * (1.0 - smoothstep(g.x + 10.0, g.x + 10.0 + f, p.x))
       * smoothstep(g.y - f, g.y, p.y) * (1.0 - smoothstep(g.y + 10.0, g.y + 10.0 + f, p.y));
}
vec3 gerstner(vec4 w, vec3 p, inout vec3 tangent, inout vec3 binormal) {
  float k = 6.2831853 / w.w;
  float c = sqrt(9.8 / k);
  vec2 d = normalize(w.xy);
  float f = k * (dot(d, p.xz) - c * uTime * ${TIME_SCALE.toFixed(2)});
  float a = w.z / k;
  tangent += vec3(-d.x * d.x * (w.z * sin(f)), d.x * (w.z * cos(f)), -d.x * d.y * (w.z * sin(f)));
  binormal += vec3(-d.x * d.y * (w.z * sin(f)), d.y * (w.z * cos(f)), -d.y * d.y * (w.z * sin(f)));
  return vec3(d.x * (a * cos(f)), a * sin(f), d.y * (a * cos(f)));
}
void main() {
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
  vec3 q = p;
  float amp = 1.0 - (1.0 - ${CALM.toFixed(2)}) * max(boardMask(p.xz, uGrids[0]), boardMask(p.xz, uGrids[1]));
  for (int i = 0; i < N; i++) { vec4 w = uWaves[i]; w.z *= amp; q += gerstner(w, p, tangent, binormal); }
  vNormal = normalize(cross(binormal, tangent));
  vWorld = q;
  vHeight = q.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(q, 1.0);
}`;

const WATER_FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uDeep, uShallow, uSky, uSunDir, uSunColor, uFog;
uniform float uFogNear, uFogFar;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vHeight;
void main() {
  // fine ripples on top of the big waves
  vec3 n = normalize(vNormal + vec3(
    sin(vWorld.x * 3.1 + uTime * 1.9) * 0.045 + sin(vWorld.z * 5.7 - uTime * 2.3) * 0.03,
    0.0,
    cos(vWorld.z * 3.4 - uTime * 1.6) * 0.045 + cos(vWorld.x * 6.1 + uTime * 2.1) * 0.03));
  vec3 v = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 col = mix(uDeep, uShallow, clamp(vHeight * 2.2 + 0.45, 0.0, 1.0));
  col = mix(col, uSky, fres * 0.75);
  vec3 h = normalize(uSunDir + v);
  float spec = pow(max(dot(n, h), 0.0), 220.0);
  col += uSunColor * spec * 3.0;
  float glint = pow(max(dot(reflect(-v, n), uSunDir), 0.0), 40.0);
  col += uSunColor * glint * 0.35;
  float foam = smoothstep(0.15, 0.24, vHeight);
  col = mix(col, vec3(0.85, 0.9, 0.95), foam * 0.4);
  float fog = smoothstep(uFogNear, uFogFar, length(cameraPosition.xz - vWorld.xz));
  gl_FragColor = vec4(mix(col, uFog, fog), 1.0);
}`;

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const SKY_FRAG = /* glsl */`
uniform vec3 uZenith, uHorizon, uSunDir, uSunColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float e = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(e, 0.45));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.45 + pow(s, 3.0) * 0.12);
  if (d.y < 0.0) col = uHorizon;
  gl_FragColor = vec4(col, 1.0);
}`;

// Grid drawn in a shader: crisp anti-aliased lines at any zoom, a tinted board, and a glowing
// highlighted cell (hover / aim).
const GRID_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const GRID_FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec2 uCell;   // highlighted cell (-1 = none)
uniform vec3 uCellColor;
uniform float uTime, uActive;
varying vec2 vUv;
void main() {
  vec2 g = vUv * ${SIZE.toFixed(1)};
  vec2 f = abs(fract(g - 0.5) - 0.5) / fwidth(g);
  float line = 1.0 - min(min(f.x, f.y), 1.0);
  vec2 edge = min(vUv, 1.0 - vUv) * ${SIZE.toFixed(1)};
  float border = 1.0 - smoothstep(0.0, 0.06, min(edge.x, edge.y));
  float a = 0.045 + line * 0.42 + border * 0.75;
  vec3 col = uColor;
  vec2 c = vec2(floor(g.x), floor(${SIZE.toFixed(1)} - g.y)); // uv.y grows northwards, rows grow southwards
  if (uCell.x >= 0.0 && c == uCell) {
    float pulse = 0.55 + 0.45 * sin(uTime * 6.0);
    col = mix(col, uCellColor, 0.9);
    a = max(a, 0.45 + 0.35 * pulse);
  }
  gl_FragColor = vec4(col * (0.7 + 0.6 * uActive), a * (0.55 + 0.45 * uActive));
}`;

// ---------- particles ----------
const PART_VERT = /* glsl */`
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const PART_FRAG = /* glsl */`
uniform float uSoft;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, uSoft, d) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}`;

class Particles {
  constructor(max, { additive, soft = 0.0 }) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.p = Array.from({ length: max }, () => ({ alive: false }));
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: PART_VERT, fragmentShader: PART_FRAG,
      uniforms: { uScale: { value: 300 }, uSoft: { value: soft } },
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.geo = g;
  }
  // o: { pos, vel, life, size:[a,b], color:[c0,c1], alpha:[a0,a1], gravity, drag }
  spawn(o) {
    const p = this.p[this.next];
    this.next = (this.next + 1) % this.max;
    p.alive = true;
    p.x = o.pos.x; p.y = o.pos.y; p.z = o.pos.z;
    p.vx = o.vel.x; p.vy = o.vel.y; p.vz = o.vel.z;
    p.t = 0; p.life = o.life;
    p.s0 = o.size[0]; p.s1 = o.size[1];
    p.c0 = o.color[0]; p.c1 = o.color[1];
    p.a0 = o.alpha[0]; p.a1 = o.alpha[1];
    p.g = o.gravity ?? 0; p.drag = o.drag ?? 0;
  }
  update(dt) {
    for (let i = 0; i < this.max; i++) {
      const p = this.p[i];
      if (!p.alive) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      p.t += dt;
      if (p.t >= p.life) { p.alive = false; this.alpha[i] = 0; this.size[i] = 0; continue; }
      const k = p.t / p.life;
      const dr = Math.max(0, 1 - p.drag * dt);
      p.vx *= dr; p.vy = p.vy * dr - p.g * dt; p.vz *= dr;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
      this.size[i] = p.s0 + (p.s1 - p.s0) * k;
      this.alpha[i] = p.a0 + (p.a1 - p.a0) * k;
      this.color[i * 3] = p.c0.r + (p.c1.r - p.c0.r) * k;
      this.color[i * 3 + 1] = p.c0.g + (p.c1.g - p.c0.g) * k;
      this.color[i * 3 + 2] = p.c0.b + (p.c1.b - p.c0.b) * k;
    }
    for (const a of ['position', 'aSize', 'aAlpha', 'aColor']) this.geo.attributes[a].needsUpdate = true;
  }
}

const C = hex => new THREE.Color(hex);

// Soft round textures for fireballs, flashes, smoke and spray (drawn once on a canvas).
const texCache = {};
function glowTex(kind) {
  if (texCache[kind]) return texCache[kind];
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  const stops = {
    fire: [[0, 'rgba(255,250,220,1)'], [0.25, 'rgba(255,200,80,0.95)'], [0.55, 'rgba(255,90,20,0.55)'], [1, 'rgba(120,20,0,0)']],
    flash: [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,240,200,0.8)'], [1, 'rgba(255,200,120,0)']],
    smoke: [[0, 'rgba(34,30,28,0.9)'], [0.5, 'rgba(45,40,37,0.55)'], [1, 'rgba(55,50,47,0)']],
    body: [[0, 'rgba(255,214,120,1)'], [0.3, 'rgba(255,140,40,0.95)'], [0.65, 'rgba(200,50,15,0.7)'], [1, 'rgba(90,15,5,0)']],
    spray: [[0, 'rgba(255,255,255,0.95)'], [0.45, 'rgba(225,240,255,0.55)'], [1, 'rgba(210,235,255,0)']],
  }[kind];
  for (const [o, col] of stops) g.addColorStop(o, col);
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return (texCache[kind] = t);
}
function glowSprite(kind, additive = true) {
  return new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex(kind), transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  }));
}
const rand = (a, b) => a + Math.random() * (b - a);
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ---------- ships (procedural low-poly warships) ----------
const MAT = {
  hull: new THREE.MeshStandardMaterial({ color: 0x3b454f, roughness: 0.65, metalness: 0.35, flatShading: true }),
  deck: new THREE.MeshStandardMaterial({ color: 0x7c868e, roughness: 0.8, metalness: 0.15, flatShading: true }),
  super: new THREE.MeshStandardMaterial({ color: 0xb6bec4, roughness: 0.55, metalness: 0.3, flatShading: true }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2b3238, roughness: 0.6, metalness: 0.5, flatShading: true }),
  stripe: new THREE.MeshStandardMaterial({ color: 0x9c2b25, roughness: 0.6, flatShading: true }),
  white: new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6 }),
  sub: new THREE.MeshStandardMaterial({ color: 0x232a31, roughness: 0.5, metalness: 0.45, flatShading: true }),
};

function hullGeometry(len, width, height) {
  const w = width / 2, bow = Math.min(0.95, len * 0.32);
  const s = new THREE.Shape();
  s.moveTo(0.06, -w * 0.82);
  s.quadraticCurveTo(0, -w * 0.8, 0, 0);
  s.quadraticCurveTo(0, w * 0.8, 0.06, w * 0.82);
  s.lineTo(len - bow, w);
  s.quadraticCurveTo(len - bow * 0.35, w * 0.85, len, 0);
  s.quadraticCurveTo(len - bow * 0.35, -w * 0.85, len - bow, -w);
  s.lineTo(0.06, -w * 0.82);
  const g = new THREE.ExtrudeGeometry(s, { depth: height, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1 });
  g.rotateX(-Math.PI / 2); // shape -> XZ plane, depth -> +Y
  g.translate(0, -height * 0.55, 0);
  return g;
}

function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function cyl(rt, rb, h, mat, x, y, z, seg = 10) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  return m;
}
function turret(x, y, back = false) {
  const g = new THREE.Group();
  g.add(cyl(0.13, 0.15, 0.09, MAT.super, 0, 0.045, 0, 12));
  g.add(box(0.2, 0.08, 0.16, MAT.super, 0.02, 0.1, 0));
  for (const dz of [-0.04, 0.04]) {
    const b = cyl(0.018, 0.018, 0.34, MAT.dark, 0, 0, 0, 6);
    b.rotation.z = -Math.PI / 2;
    b.position.set(0.24, 0.11, dz);
    g.add(b);
  }
  g.position.set(x, y, 0);
  if (back) g.rotation.y = Math.PI;
  return g;
}
function funnel(x, y, h = 0.28) {
  const g = new THREE.Group();
  g.add(cyl(0.07, 0.09, h, MAT.super, 0, h / 2, 0));
  g.add(cyl(0.072, 0.072, 0.05, MAT.dark, 0, h, 0));
  g.position.set(x, y, 0);
  return g;
}
function mast(x, y, h = 0.6) {
  const g = new THREE.Group();
  g.add(cyl(0.015, 0.02, h, MAT.dark, 0, h / 2, 0, 5));
  g.add(box(0.03, 0.03, 0.22, MAT.dark, 0, h * 0.75, 0));
  const r = box(0.08, 0.05, 0.02, MAT.super, 0, h, 0);
  g.add(r);
  g.userData.radar = r;
  g.position.set(x, y, 0);
  return g;
}

function buildShip(type, len) {
  const L = len - 0.12;
  const g = new THREE.Group();
  const inner = new THREE.Group(); // ship drawn from x=0 (stern) to x=L (bow)
  inner.position.x = -L / 2;
  g.add(inner);
  const deckY = 0.13;
  if (type === 'submarine') {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, L - 0.45, 6, 12), MAT.sub);
    body.rotation.z = Math.PI / 2;
    body.scale.set(1, 1, 0.9);
    body.position.set(L / 2, -0.02, 0);
    inner.add(body);
    const sail = box(0.42, 0.26, 0.12, MAT.sub, L * 0.58, 0.24, 0);
    inner.add(sail);
    inner.add(box(0.06, 0.02, 0.4, MAT.sub, L * 0.62, 0.24, 0)); // sail planes
    inner.add(cyl(0.012, 0.012, 0.22, MAT.dark, L * 0.55, 0.46, 0, 5)); // periscope
    const fin = box(0.14, 0.18, 0.02, MAT.sub, 0.1, 0.05, 0);
    inner.add(fin);
  } else {
    const width = { carrier: 0.7, battleship: 0.66, cruiser: 0.58, destroyer: 0.5 }[type];
    const hull = new THREE.Mesh(hullGeometry(L, width, 0.3), [MAT.deck, MAT.hull]);
    inner.add(hull);
    const stripe = new THREE.Mesh(hullGeometry(L * 0.995, width * 1.02, 0.04), MAT.stripe);
    stripe.position.y = -0.17;
    inner.add(stripe);
    if (type === 'carrier') {
      inner.add(box(L * 0.98, 0.05, 0.84, MAT.deck, L * 0.5, deckY + 0.02, 0.03));
      inner.add(box(L * 0.8, 0.006, 0.02, MAT.white, L * 0.52, deckY + 0.05, 0.05));
      for (let i = 0; i < 5; i++) inner.add(box(0.12, 0.006, 0.02, MAT.white, L * 0.15 + i * 0.35, deckY + 0.05, -0.2));
      inner.add(box(0.5, 0.3, 0.16, MAT.super, L * 0.6, deckY + 0.2, -0.3));
      inner.add(box(0.3, 0.14, 0.14, MAT.super, L * 0.6, deckY + 0.42, -0.3));
      const m = mast(L * 0.62, deckY + 0.48, 0.42); m.position.z = -0.3; inner.add(m); g.userData.radar = m.userData.radar;
      // parked jets
      for (let i = 0; i < 3; i++) {
        const j = new THREE.Group();
        j.add(box(0.22, 0.03, 0.05, MAT.dark, 0, 0, 0));
        j.add(box(0.06, 0.02, 0.2, MAT.dark, -0.02, 0, 0));
        j.position.set(L * 0.2 + i * 0.32, deckY + 0.07, 0.25);
        j.rotation.y = 0.5;
        inner.add(j);
      }
    } else {
      const sl = { battleship: 1.2, cruiser: 0.9, destroyer: 0.55 }[type];
      const sx = L * (type === 'destroyer' ? 0.42 : 0.47);
      inner.add(box(sl, 0.14, width * 0.6, MAT.super, sx, deckY + 0.07, 0));
      inner.add(box(sl * 0.55, 0.14, width * 0.45, MAT.super, sx + sl * 0.12, deckY + 0.21, 0));
      inner.add(box(sl * 0.3, 0.1, width * 0.35, MAT.dark, sx + sl * 0.2, deckY + 0.32, 0)); // bridge windows
      inner.add(funnel(sx - sl * 0.3, deckY + 0.14, type === 'destroyer' ? 0.22 : 0.3));
      const m = mast(sx + sl * 0.08, deckY + 0.36, 0.5); inner.add(m); g.userData.radar = m.userData.radar;
      if (type === 'battleship') {
        inner.add(turret(L - 0.75, deckY));
        inner.add(turret(L - 1.15, deckY + 0.06));
        inner.add(turret(0.45, deckY, true));
      } else if (type === 'cruiser') {
        inner.add(turret(L - 0.6, deckY));
        inner.add(turret(0.4, deckY, true));
      } else {
        inner.add(turret(L - 0.45, deckY));
      }
    }
  }
  g.traverse(o => { if (o.isMesh) o.castShadow = false; });
  return g;
}

// ---------- the scene ----------
export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

export class Battle3D {
  constructor(container, { onCell, onShip, canDrag, onShipDrag, onShipDrop } = {}) {
    this.container = container;
    this.onCell = onCell;
    this.onShip = onShip;
    this.canDrag = canDrag;       // () => may ships be dragged right now (placement)
    this.onShipDrag = onShipDrag; // (type, x, y) => is that spot legal
    this.onShipDrop = onShipDrop; // (type, x, y, ok)
    this.clock = new THREE.Clock();
    this.t = 0;
    this.fires = []; // persistent burning spots
    this.anims = []; // per-frame tweens: fn(dt) -> done?
    this.shakeAmt = 0;
    this.opts = { smoke: true, fire: true, shake: true, bloom: true, topDown: false, chase: true };
    this.follow = null; // chase camera target while a missile flies

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.append(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    const fogColor = C('#e8a37d');
    scene.fog = new THREE.Fog(fogColor, 30, 120);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);

    // sky
    const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false,
      uniforms: { uZenith: { value: C('#16294f') }, uHorizon: { value: fogColor }, uSunDir: { value: SUN_DIR }, uSunColor: { value: C('#ffcf8a') } },
    }));
    sky.renderOrder = -1;
    scene.add(sky);
    this.sky = sky;

    // ocean
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(220, 220, 220, 220).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      vertexShader: WATER_VERT, fragmentShader: WATER_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uWaves: { value: WAVES.map(w => new THREE.Vector4(...w)) },
        uGrids: { value: Object.values(GRIDS).map(g => new THREE.Vector4(g.ox, g.oz, 0, 0)) },
        uDeep: { value: C('#062033') }, uShallow: { value: C('#17607d') }, uSky: { value: C('#b98a7c') },
        uSunDir: { value: SUN_DIR }, uSunColor: { value: C('#ffd7a0') }, uFog: { value: fogColor },
        uFogNear: { value: 25 }, uFogFar: { value: 110 },
      },
    }));
    this.water.position.z = -4;
    scene.add(this.water);

    // light
    scene.add(new THREE.HemisphereLight(0xffd9c0, 0x10324a, 1.1));
    const sun = new THREE.DirectionalLight(0xffd2a0, 2.4);
    sun.position.copy(SUN_DIR).multiplyScalar(50);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x8fb6ff, 0.6);
    fill.position.set(10, 12, 20);
    scene.add(fill);

    // grids
    this.grids = {};
    for (const [name, g] of Object.entries(GRIDS)) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: GRID_VERT, fragmentShader: GRID_FRAG, transparent: true, depthWrite: false,
        uniforms: {
          uColor: { value: C(name === 'mine' ? '#7fe9ff' : '#ff9e7a') },
          uCell: { value: new THREE.Vector2(-1, -1) },
          uCellColor: { value: C(name === 'mine' ? '#ffffff' : '#ffef6b') },
          uTime: { value: 0 }, uActive: { value: 1 },
        },
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), mat);
      mesh.position.set(g.ox + SIZE / 2, GRID_Y, g.oz + SIZE / 2);
      mesh.renderOrder = 2;
      mesh.userData.grid = name;
      scene.add(mesh);
      this.grids[name] = mesh;
      this.addLabels(name);
    }

    // particles
    this.fireP = new Particles(1400, { additive: true, soft: 0.0 });
    this.smokeP = new Particles(900, { additive: false, soft: 0.05 });
    this.waterP = new Particles(900, { additive: false, soft: 0.15 });
    for (const p of [this.smokeP, this.waterP, this.fireP]) scene.add(p.points);

    this.flash = new THREE.PointLight(0xffa040, 0, 18, 1.6);
    scene.add(this.flash);

    this.ships = { mine: new Map(), enemy: new Map() }; // type -> { group, spec, sunk }
    this.markers = new Map(); // "grid:x,y" -> mesh
    this.missiles = [];

    // post-processing: bloom makes fire, flashes and the sun glow
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.55, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.quality = 'high';
    this.frameTimes = [];

    // camera
    this.view = 'mine';
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camFrom = null;

    this.raycaster = new THREE.Raycaster();
    this.bindInput();
    this.resize = this.resize.bind(this);
    addEventListener('resize', this.resize);
    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(container);
    this.resize();
    this.setView('mine', true);
    this.running = true;
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    this.onVis = () => { if (!document.hidden) this.clock.getDelta(); };
    document.addEventListener('visibilitychange', this.onVis);
  }

  addLabels(name) {
    const g = GRIDS[name];
    const mk = text => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const x = c.getContext('2d');
      x.fillStyle = name === 'mine' ? '#c9f6ff' : '#ffd2c0';
      x.font = 'bold 40px Rubik, sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.shadowColor = 'rgba(0,0,0,.6)';
      x.shadowBlur = 6;
      x.fillText(text, 32, 34);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      s.scale.set(0.55, 0.55, 1);
      return s;
    };
    for (let i = 0; i < SIZE; i++) {
      const col = mk('ABCDEFGHIJ'[i]);
      col.position.set(g.ox + i + 0.5, GRID_Y + 0.15, g.oz - 0.45);
      this.scene.add(col);
      const row = mk(String(i + 1));
      row.position.set(g.ox - 0.5, GRID_Y + 0.15, g.oz + i + 0.5);
      this.scene.add(row);
    }
  }

  cellPos(grid, x, y) {
    const g = GRIDS[grid];
    return new THREE.Vector3(g.ox + x + 0.5, 0, g.oz + y + 0.5);
  }

  // ---------- camera ----------
  presetFor(view) {
    const pitch = THREE.MathUtils.degToRad(this.opts.topDown ? 84 : view === 'overview' ? 52 : 38);
    const back = new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch));
    // board corners that must be on screen (with room for the labels)
    let corners;
    if (view === 'overview') {
      corners = [[-6, -14], [6, -14], [-6, 12.6], [6, 12.6]];
    } else {
      const g = GRIDS[view];
      corners = [[g.ox - 1, g.oz - 1], [g.ox + SIZE + 0.3, g.oz - 1], [g.ox - 1, g.oz + SIZE + 0.2], [g.ox + SIZE + 0.3, g.oz + SIZE + 0.2]];
    }
    corners = corners.map(([x, z]) => new THREE.Vector3(x, GRID_Y, z));
    // screen band kept free of HUD: top panels and bottom buttons
    const portrait = this.camera.aspect < 0.8;
    const top = portrait ? 0.62 : 0.52, bottom = portrait ? -0.55 : -0.76, side = portrait ? 0.96 : 0.8;
    const cam = this.camera.clone();
    const center = corners.reduce((a, c) => a.add(c), new THREE.Vector3()).multiplyScalar(1 / corners.length);
    const look = center.clone();
    let dist = 25;
    const v = new THREE.Vector3();
    // fit: grow/shrink distance and slide the aim point until the board fills the band
    for (let i = 0; i < 60; i++) {
      cam.position.copy(look).addScaledVector(back, dist);
      cam.lookAt(look);
      cam.updateMatrixWorld();
      let minX = 9, maxX = -9, minY = 9, maxY = -9;
      for (const c of corners) {
        v.copy(c).project(cam);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      }
      const scale = Math.max(maxX / side, -minX / side, (maxY - minY) / (top - bottom));
      dist *= Math.pow(scale, 0.7);
      const shift = (maxY + minY) / 2 - (top + bottom) / 2;
      look.z -= shift * dist * 0.25;
    }
    return { pos: look.clone().addScaledVector(back, dist), look };
  }

  setView(view, immediate = false) {
    this.view = view;
    const p = this.presetFor(view);
    if (immediate) {
      this.camPos.copy(p.pos);
      this.camLook.copy(p.look);
      this.camFrom = null;
      return Promise.resolve();
    }
    this.camFrom = { pos: this.camPos.clone(), look: this.camLook.clone(), to: p, t: 0, dur: 1.3 };
    return new Promise(res => { this.camFrom.done = res; });
  }

  resize() {
    const w = this.container.clientWidth || innerWidth, h = this.container.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2); // half-resolution bloom (cheaper on phones)
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 58 : 45; // tall phone screens: wider view so sea and sky fit
    this.camera.updateProjectionMatrix();
    for (const p of [this.fireP, this.smokeP, this.waterP]) p.mat.uniforms.uScale.value = h * this.renderer.getPixelRatio() * 0.9;
    // screen rotated / resized: re-fit the board (also mid camera move)
    if (this.camFrom) this.camFrom.to = this.presetFor(this.view);
    else this.setView(this.view, true);
  }

  shake(amount) { if (this.opts.shake) this.shakeAmt = Math.max(this.shakeAmt, amount); }

  // Player's visual settings: { smoke, fire, shake, bloom, topDown }
  setOptions(o) {
    const viewChanged = o.topDown !== undefined && o.topDown !== this.opts.topDown;
    Object.assign(this.opts, o);
    this.bloom.enabled = this.opts.bloom && this.quality !== 'low';
    if (!this.opts.shake) this.shakeAmt = 0;
    if (viewChanged) this.setView(this.view);
  }
  smokeSpawn(o) { if (this.opts.smoke) this.smokeP.spawn(o); }

  // ---------- input ----------
  bindInput() {
    const el = this.renderer.domElement;
    let down = null, drag = null;
    el.addEventListener('pointerdown', e => {
      down = { x: e.clientX, y: e.clientY };
      // placing the fleet: grab a ship to drag it
      if (this.canDrag?.()) {
        const type = this.shipAt(e.clientX, e.clientY);
        const c = type && this.cellAt(e.clientX, e.clientY);
        if (c && c.grid === 'mine') {
          const sp = this.ships.mine.get(type).spec;
          drag = { type, sx: c.x, sy: c.y, ax: sp.x, ay: sp.y, nx: sp.x, ny: sp.y, ok: true, moved: false };
          try { el.setPointerCapture(e.pointerId); } catch {}
        }
      }
    });
    el.addEventListener('pointermove', e => {
      if (drag) {
        if (!drag.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 10) return;
        if (!drag.moved) { drag.moved = true; this.liftShip(drag.type, true); }
        const c = this.cellAt(e.clientX, e.clientY);
        if (!c || c.grid !== 'mine') return;
        const nx = drag.ax + c.x - drag.sx, ny = drag.ay + c.y - drag.sy;
        if (nx === drag.nx && ny === drag.ny) return;
        drag.nx = nx; drag.ny = ny;
        drag.ok = this.onShipDrag?.(drag.type, nx, ny) ?? true;
        this.moveShipTo(drag.type, nx, ny, drag.ok);
        return;
      }
      if (e.pointerType === 'mouse') this.hover = this.cellAt(e.clientX, e.clientY);
    });
    const up = e => {
      if (drag && drag.moved) {
        const d = drag;
        drag = null; down = null;
        this.liftShip(d.type, false);
        this.onShipDrop?.(d.type, d.nx, d.ny, d.ok && (d.nx !== d.ax || d.ny !== d.ay));
        return;
      }
      drag = null;
      if (!down || e.type === 'pointercancel') { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 12) return;
      this.pick(e.clientX, e.clientY);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', () => { this.hover = null; });
  }

  shipAt(cx, cy) {
    const groups = [...this.ships.mine.values()].filter(s => !s.sunk).map(s => s.group);
    const sh = this.ray(cx, cy).intersectObjects(groups, true)[0];
    let o = sh?.object;
    while (o && !o.userData.shipType) o = o.parent;
    return o?.userData.shipType || null;
  }

  // While dragging: the ship floats a little above the water, tinted green (fits) or red.
  liftShip(type, on) {
    const e = this.ships.mine.get(type);
    if (!e) return;
    e.dragging = on;
    this.tint(e, on ? 0x1fb36b : null);
  }
  tint(e, color) {
    e.group.traverse(o => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) if (m.emissive) { m.emissive.set(color ?? 0x000000); m.emissiveIntensity = color ? 0.7 : 1; }
    });
  }
  moveShipTo(type, x, y, ok) {
    const e = this.ships.mine.get(type);
    if (!e) return;
    const s = { ...e.spec, x, y };
    const g = GRIDS.mine;
    e.base.set(g.ox + (s.dir === 'h' ? x + s.len / 2 : x + 0.5), 0, g.oz + (s.dir === 'h' ? y + 0.5 : y + s.len / 2));
    e.group.position.x = e.base.x;
    e.group.position.z = e.base.z;
    this.tint(e, ok ? 0x1fb36b : 0xd4231a);
  }

  ray(cx, cy) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
    return this.raycaster;
  }

  cellAt(cx, cy) {
    const hits = this.ray(cx, cy).intersectObjects(Object.values(this.grids), false);
    if (!hits.length) return null;
    const h = hits[0];
    const grid = h.object.userData.grid;
    const g = GRIDS[grid];
    const x = Math.floor(h.point.x - g.ox), y = Math.floor(h.point.z - g.oz);
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return null;
    return { grid, x, y };
  }

  pick(cx, cy) {
    // own ships first (to select them while placing)
    const type = this.shipAt(cx, cy);
    if (type && this.onShip?.(type) !== false) return;
    const c = this.cellAt(cx, cy);
    if (c) this.onCell?.(c.grid, c.x, c.y);
  }

  // ---------- state sync ----------
  // fleet: [{ type, x, y, dir, len, hits?, sunk? }], grid: 'mine' | 'enemy'
  syncShips(grid, fleet, { ghost = false, selected = null } = {}) {
    const map = this.ships[grid];
    const keep = new Set();
    for (const s of fleet || []) {
      keep.add(s.type);
      let e = map.get(s.type);
      if (e && (e.sunk || e.darkened) && !s.sunk && !e.sinking) { // new battle: a fresh ship, not last game's wreck
        this.scene.remove(e.group);
        map.delete(s.type);
        e = null;
      }
      if (!e) {
        const group = buildShip(s.type, s.len);
        group.rotation.order = 'YZX'; // yaw in the world, then pitch along the hull and roll across it
        group.userData.shipType = s.type;
        group.traverse(o => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); });
        this.scene.add(group);
        e = { group, sunk: false, sinking: false };
        map.set(s.type, e);
      }
      e.spec = s;
      const len = s.len;
      const cx = s.dir === 'h' ? s.x + len / 2 : s.x + 0.5;
      const cy = s.dir === 'h' ? s.y + 0.5 : s.y + len / 2;
      const g = GRIDS[grid];
      e.base = new THREE.Vector3(g.ox + cx, 0, g.oz + cy);
      // bow faces right (+x) for horizontal ships, down the board (+z) for vertical ones
      e.yaw = s.dir === 'h' ? 0 : -Math.PI / 2;
      if (!e.sinking && !e.sunk) e.group.position.x = e.base.x, e.group.position.z = e.base.z;
      e.group.rotation.y = e.yaw;
      const sel = selected === s.type;
      e.group.traverse(o => {
        if (!o.isMesh) return;
        for (const m of [].concat(o.material)) {
          m.transparent = ghost;
          m.opacity = ghost ? 0.35 : 1;
          if (m.emissive) m.emissive.set(sel ? 0x2a8cff : 0x000000);
          if (m.emissiveIntensity !== undefined) m.emissiveIntensity = sel ? 0.9 : 1;
        }
      });
      if (s.sunk && !e.sunk && !e.sinking) { // already sunk when we arrived: show the wreck
        this.wreck(e);
      }
    }
    for (const [type, e] of map) {
      if (!keep.has(type)) { this.scene.remove(e.group); map.delete(type); }
    }
  }

  // shots: { "x,y": 'hit' | 'miss' } on grid; skip: Set of keys still being animated
  syncMarkers(grid, shots, skip = new Set()) {
    const seen = new Set();
    for (const [key, res] of Object.entries(shots || {})) {
      const id = `${grid}:${key}`;
      if (skip.has(id)) continue;
      seen.add(id);
      if (this.markers.has(id)) continue;
      const [x, y] = key.split(',').map(Number);
      this.addMarker(grid, x, y, res);
    }
    for (const [id, m] of this.markers) {
      if (id.startsWith(grid + ':') && !seen.has(id) && !skip.has(id)) {
        this.scene.remove(m.mesh);
        this.markers.delete(id);
        this.fires = this.fires.filter(f => f.id !== id);
      }
    }
  }

  addMarker(grid, x, y, res) {
    const id = `${grid}:${x},${y}`;
    const p = this.cellPos(grid, x, y);
    const g = new THREE.Group();
    const hit = res === 'hit';
    const pegMat = new THREE.MeshStandardMaterial({
      color: hit ? 0xff3b2f : 0xf4f7fa, roughness: 0.4,
      emissive: hit ? 0xff2200 : 0x223344, emissiveIntensity: hit ? 1.4 : 0.2,
    });
    g.add(cyl(0.07, 0.09, 0.32, pegMat, 0, 0.16, 0, 10));
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), pegMat);
    top.position.y = 0.33;
    g.add(top);
    if (!hit) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.22, 24).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
      ring.position.y = 0.02;
      g.add(ring);
    }
    if (hit) {
      const flame = glowSprite('fire');
      flame.position.y = 0.55;
      flame.scale.setScalar(1.1);
      g.add(flame);
      g.userData.flame = flame;
    }
    g.position.copy(p);
    this.scene.add(g);
    this.markers.set(id, { mesh: g, x: p.x, z: p.z, hit, seed: Math.random() * 10 });
    if (hit) this.fires.push({ id, x: p.x, z: p.z, acc: 0 });
  }

  setHighlight(grid, cell) {
    for (const [name, m] of Object.entries(this.grids)) {
      m.material.uniforms.uCell.value.set(name === grid && cell ? cell.x : -1, name === grid && cell ? cell.y : -1);
    }
  }

  setActiveGrid(name) {
    for (const [n, m] of Object.entries(this.grids)) m.material.uniforms.uActive.value = !name || n === name ? 1 : 0.35;
  }

  // ---------- effects ----------
  // A sprite that grows and fades: s0 -> s1 world units over `dur`, rising `rise` units.
  puff(kind, pos, { s0, s1, dur, rise = 0, delay = 0, additive = true, opacity = 1, drift = null }) {
    if (kind === 'smoke' && !this.opts.smoke) return;
    const sp = glowSprite(kind, additive);
    sp.position.copy(pos);
    sp.scale.setScalar(0.0001);
    sp.material.rotation = Math.random() * Math.PI * 2;
    this.scene.add(sp);
    let t = -delay;
    const start = pos.clone();
    this.anims.push(dt => {
      t += dt;
      if (t < 0) return false;
      const k = Math.min(t / dur, 1);
      const e = 1 - Math.pow(1 - k, 3);
      sp.scale.setScalar(s0 + (s1 - s0) * e);
      sp.position.set(start.x + (drift ? drift.x * k : 0), start.y + rise * e, start.z + (drift ? drift.z * k : 0));
      sp.material.opacity = opacity * (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85);
      if (k >= 1) { this.scene.remove(sp); sp.material.dispose(); return true; }
      return false;
    });
  }

  explosion(pos, big = false) {
    const B = big ? 1.5 : 1;
    // white-hot flash, then a rolling fireball with secondary blasts, then a smoke column
    this.puff('flash', pos, { s0: 0.4, s1: 3 * B, dur: 0.22, opacity: 1 });
    // fireball body in normal blending keeps its orange/red colour over the bright sea
    this.puff('body', pos, { s0: 0.5, s1: 2.8 * B, dur: 0.9, rise: 0.9, additive: false, opacity: 0.95 });
    this.puff('fire', pos, { s0: 0.3, s1: 1.6 * B, dur: 0.5, rise: 0.5, opacity: 0.9 });
    for (let i = 0; i < (big ? 7 : 4); i++) {
      const off = new THREE.Vector3(rand(-0.8, 0.8) * B, rand(0.1, 0.9), rand(-0.8, 0.8) * B);
      this.puff('body', pos.clone().add(off), { s0: 0.3, s1: rand(1.3, 2.2) * B, dur: rand(0.6, 1.1), rise: rand(0.6, 1.6), delay: rand(0.05, 0.35), additive: false, opacity: 0.9 });
    }
    for (let i = 0; i < (big ? 9 : 5); i++) {
      this.puff('smoke', pos.clone().add(new THREE.Vector3(rand(-0.5, 0.5), 0.7, rand(-0.5, 0.5))), {
        s0: 0.8, s1: rand(3, 5) * B, dur: rand(3, 4.5), rise: rand(3, 5), delay: rand(0.25, 0.8), additive: false, opacity: 0.85,
        drift: { x: rand(0.4, 1.4), z: rand(-0.6, 0.2) },
      });
    }
    const n = big ? 120 : 70;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, up = rand(0.2, 1), sp = rand(1.5, big ? 6 : 4.5);
      this.fireP.spawn({
        pos, vel: { x: Math.cos(a) * sp * (1 - up * 0.5), y: up * sp * 1.2, z: Math.sin(a) * sp * (1 - up * 0.5) },
        life: rand(0.4, 0.9), size: [rand(0.9, 1.4), rand(2.2, 3.4)],
        color: [C('#fff1b0'), C('#ff3d00')], alpha: [1, 0], gravity: -0.6, drag: 2.2,
      });
    }
    for (let i = 0; i < (big ? 40 : 25); i++) {
      const a = Math.random() * Math.PI * 2;
      this.fireP.spawn({
        pos, vel: { x: Math.cos(a) * rand(4, 9), y: rand(3, 8), z: Math.sin(a) * rand(4, 9) },
        life: rand(0.5, 1.1), size: [0.18, 0.05], color: [C('#ffe08a'), C('#ff5a1f')], alpha: [1, 0.2], gravity: 9.8, drag: 0.6,
      });
    }
    for (let i = 0; i < (big ? 45 : 28); i++) {
      this.smokeSpawn({
        pos: { x: pos.x + rand(-0.3, 0.3), y: pos.y + rand(0.1, 0.5), z: pos.z + rand(-0.3, 0.3) },
        vel: { x: rand(-0.6, 0.6), y: rand(0.8, 2), z: rand(-0.6, 0.6) },
        life: rand(1.6, 3.2), size: [rand(0.8, 1.2), rand(2.6, 4)], color: [C('#3a3330'), C('#8b8580')], alpha: [0.75, 0], gravity: -0.15, drag: 0.8,
      });
    }
    this.waterSplash(pos, big ? 0.7 : 0.5);
    this.shockwave(pos, 0xffb070, big ? 4.5 : 3);
    this.flash.position.set(pos.x, pos.y + 1, pos.z);
    this.flash.intensity = big ? 90 : 55;
    this.shake(big ? 0.55 : 0.32);
  }

  waterSplash(pos, scale = 1) {
    // spray column
    this.puff('spray', pos.clone().setY(0.4), { s0: 0.4, s1: 2.4 * scale, dur: 1.1, rise: 2.2 * scale, additive: false, opacity: 0.9 });
    this.puff('spray', pos.clone().setY(0.3), { s0: 0.6, s1: 3.2 * scale, dur: 1.6, rise: 0.6, additive: false, opacity: 0.55, delay: 0.15 });
    for (let i = 0; i < 70 * scale; i++) {
      const a = Math.random() * Math.PI * 2, r = rand(0.2, 1.6);
      this.waterP.spawn({
        pos: { x: pos.x + rand(-0.15, 0.15), y: pos.y, z: pos.z + rand(-0.15, 0.15) },
        vel: { x: Math.cos(a) * r, y: rand(3.5, 7.5) * scale + 1, z: Math.sin(a) * r },
        life: rand(0.8, 1.4), size: [rand(0.18, 0.35), rand(0.35, 0.6)], color: [C('#ffffff'), C('#bfe6ff')], alpha: [0.95, 0], gravity: 9.8, drag: 0.3,
      });
    }
    for (let i = 0; i < 18 * scale; i++) {
      this.waterP.spawn({
        pos, vel: { x: rand(-1, 1), y: rand(0.5, 1.5), z: rand(-1, 1) },
        life: rand(1, 1.8), size: [0.6, 1.8], color: [C('#ffffff'), C('#d8eefc')], alpha: [0.5, 0], gravity: 0.5, drag: 1.2,
      });
    }
    this.shockwave(pos, 0xffffff, 2.2, true);
  }

  shockwave(pos, color, radius, water = false) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.33, 0.39, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: water ? 0.7 : 0.9, depthWrite: false,
      blending: water ? THREE.NormalBlending : THREE.AdditiveBlending,
    }));
    m.position.set(pos.x, water ? 0.25 : pos.y + 0.1, pos.z);
    this.scene.add(m);
    let t = 0;
    const dur = water ? 1.4 : 0.6;
    this.anims.push(dt => {
      t += dt;
      const k = Math.min(t / dur, 1);
      const s = 1 + (radius / 0.36) * (1 - Math.pow(1 - k, 3));
      m.scale.set(s, 1, s);
      m.material.opacity = (water ? 0.3 : 0.8) * (1 - k);
      if (k >= 1) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); return true; }
      return false;
    });
  }

  // Missile on an arc from `from` to `to`; resolves on impact.
  missile(from, to) {
    return new Promise(resolve => {
      const g = new THREE.Group();
      const body = cyl(0.06, 0.06, 0.5, new THREE.MeshStandardMaterial({ color: 0xdfe5ea, metalness: 0.5, roughness: 0.35 }), 0, 0, 0, 10);
      body.rotation.x = Math.PI / 2;
      g.add(body);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 10), new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.4 }));
      nose.rotation.x = Math.PI / 2;
      nose.position.z = 0.33;
      g.add(nose);
      for (let i = 0; i < 4; i++) {
        const fin = box(0.01, 0.12, 0.12, MAT.dark, 0, 0, -0.2);
        fin.rotation.z = (i * Math.PI) / 2;
        fin.position.set(Math.cos((i * Math.PI) / 2) * 0.06, Math.sin((i * Math.PI) / 2) * 0.06, -0.2);
        g.add(fin);
      }
      const glow = new THREE.PointLight(0xff8a3d, 12, 6, 2);
      glow.position.z = -0.35;
      g.add(glow);
      const flare = glowSprite('fire');
      flare.scale.setScalar(1.1);
      flare.position.z = -0.4;
      g.add(flare);
      g.scale.setScalar(1.7);
      this.scene.add(g);
      if (this.opts.chase) this.follow = { obj: g, to: to.clone(), dir: new THREE.Vector3(0, 0, -1) };
      const p0 = from.clone(), p2 = to.clone();
      const dist = p0.distanceTo(p2);
      const p1 = p0.clone().lerp(p2, 0.5);
      p1.y += 4 + dist * 0.35;
      const curve = new THREE.QuadraticBezierCurve3(p0, p1, p2);
      const dur = 1.1 + dist * 0.035;
      let t = 0, acc = 0;
      this.anims.push(dt => {
        t += dt;
        const k = Math.min(t / dur, 1);
        const u = k < 0.15 ? k * k / 0.3 : k - 0.075; // slow launch, then full speed
        const uu = Math.min(Math.max(u / 0.925, 0), 1);
        const pos = curve.getPoint(uu);
        const ahead = curve.getPoint(Math.min(uu + 0.01, 1));
        g.position.copy(pos);
        g.lookAt(ahead);
        if (this.follow?.obj === g && uu < 0.995) this.follow.dir.subVectors(ahead, pos).normalize();
        acc += dt;
        while (acc > 0.012) { // exhaust trail
          acc -= 0.012;
          const back = new THREE.Vector3(0, 0, -0.6).applyQuaternion(g.quaternion).add(pos);
          this.fireP.spawn({ pos: back, vel: { x: rand(-0.2, 0.2), y: rand(-0.2, 0.2), z: rand(-0.2, 0.2) }, life: 0.3, size: [0.8, 0.2], color: [C('#fff3c4'), C('#ff6a00')], alpha: [1, 0], drag: 1 });
          this.smokeSpawn({ pos: back, vel: { x: rand(-0.15, 0.15), y: rand(0.05, 0.3), z: rand(-0.15, 0.15) }, life: rand(1.2, 2), size: [0.35, 1.25], color: [C('#e6e1dc'), C('#a39d98')], alpha: [0.5, 0], drag: 0.6 });
        }
        if (k >= 1) {
          this.scene.remove(g);
          resolve();
          return true;
        }
        return false;
      });
    });
  }

  // Wait in scene time (follows the animation speed).
  simWait(secs) {
    return new Promise(res => {
      let t = 0;
      this.anims.push(dt => { t += dt; if (t >= secs) { res(); return true; } return false; });
    });
  }

  launchPoint(grid) {
    // from a random surviving ship of that side, or the middle of its waters
    const alive = [...this.ships[grid].values()].filter(s => !s.sunk && !s.sinking && s.group.visible);
    if (alive.length) {
      const s = alive[Math.floor(Math.random() * alive.length)];
      return s.group.position.clone().add(new THREE.Vector3(0, 0.5, 0));
    }
    const g = GRIDS[grid];
    return new THREE.Vector3(g.ox + SIZE / 2, 1, g.oz + (grid === 'enemy' ? -2 : SIZE + 2));
  }

  // Full shot sequence on the target grid. result: 'miss' | 'hit' | 'sunk'
  async shot(targetGrid, x, y, result) {
    const from = this.launchPoint(targetGrid === 'enemy' ? 'mine' : 'enemy');
    const to = this.cellPos(targetGrid, x, y);
    to.y = waveHeight(to.x, to.z, this.t) + 0.1;
    this.setHighlight(targetGrid, { x, y });
    await this.missile(from, to);
    this.setHighlight(null, null);
    if (result === 'miss') this.waterSplash(to, 1);
    else this.explosion(to.clone().setY(to.y + 0.2), result === 'sunk');
    this.addMarker(targetGrid, x, y, result === 'miss' ? 'miss' : 'hit');
    this.markers.get(`${targetGrid}:${x},${y}`).fresh = true;
    if (this.follow) {
      // chase camera: hold on the impact for a moment, then pull back to the board
      this.follow.obj = null;
      await this.simWait(result === 'miss' ? 0.9 : 1.3);
      this.follow = null;
      this.setView(this.view);
    }
  }

  darken(e) {
    if (e.darkened) return;
    e.darkened = true;
    e.group.traverse(o => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) { if (m.color) m.color.multiplyScalar(0.5); }
    });
  }

  // A sunk ship stays on the board as a wreck: low in the water, listing, scorched.
  wreck(e) {
    this.darken(e);
    e.sunk = true;
    e.sinking = false;
    e.group.visible = true;
    e.wreckRoll = e.wreckRoll ?? rand(0.22, 0.32) * (Math.random() < 0.5 ? -1 : 1);
    e.wreckPitch = e.wreckPitch ?? rand(-0.1, 0.1);
    e.group.rotation.z = e.wreckPitch;
    e.group.rotation.x = e.wreckRoll;
    e.group.position.set(e.base.x, WRECK_Y, e.base.z);
  }

  // Sink a ship: it lists, rolls and settles low in the water with bubbles and smoke.
  sinkShip(grid, type) {
    const e = this.ships[grid].get(type);
    if (!e || e.sinking || e.sunk) return Promise.resolve();
    e.sinking = true;
    const g = e.group;
    e.wreckRoll = rand(0.22, 0.32) * (Math.random() < 0.5 ? -1 : 1);
    e.wreckPitch = rand(-0.1, 0.1);
    const roll = e.wreckRoll * 2.2, pitch = e.wreckPitch * 2;
    this.darken(e);
    return new Promise(res => {
      let t = 0, acc = 0;
      const dur = 3.2;
      const startY = g.position.y;
      this.anims.push(dt => {
        t += dt;
        const k = Math.min(t / dur, 1);
        // heel over hard, then settle back to the wreck's resting list
        const heel = k < 0.5 ? ease(k * 2) : 1 - ease((k - 0.5) * 2) * 0.55;
        g.rotation.x = roll * heel;
        g.rotation.z = pitch * ease(k);
        g.position.y = startY + (WRECK_Y - startY) * ease(k);
        acc += dt;
        if (acc > 0.05 && k < 0.9) {
          acc = 0;
          const p = g.position;
          this.waterP.spawn({ pos: { x: p.x + rand(-0.8, 0.8), y: 0.25, z: p.z + rand(-0.8, 0.8) }, vel: { x: 0, y: rand(0.3, 0.8), z: 0 }, life: 0.8, size: [0.15, 0.3], color: [C('#ffffff'), C('#cdeeff')], alpha: [0.9, 0], drag: 1 });
          this.smokeSpawn({ pos: { x: p.x + rand(-0.5, 0.5), y: 0.6, z: p.z + rand(-0.5, 0.5) }, vel: { x: rand(-0.2, 0.2), y: rand(0.8, 1.4), z: rand(-0.2, 0.2) }, life: 2.5, size: [0.8, 2.6], color: [C('#2c2724'), C('#6f6a66')], alpha: [0.6, 0], drag: 0.5 });
        }
        if (k >= 1) {
          this.wreck(e);
          res();
          return true;
        }
        return false;
      });
    });
  }

  // Reveal an enemy ship (when sunk) so the player sees what they destroyed, then sink it.
  revealAndSink(spec) {
    this.syncShips('enemy', [...[...this.ships.enemy.values()].map(e => e.spec), spec]);
    const e = this.ships.enemy.get(spec.type);
    if (e) { e.sunk = false; e.group.visible = true; e.group.position.y = 0; }
    return new Promise(r => setTimeout(r, 350)).then(() => this.sinkShip('enemy', spec.type));
  }

  // ---------- frame ----------
  loop() {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const dt = Math.min(this.clock.getDelta(), 0.05) * (window.__bsSpeed || 1); // __bsSpeed: tests only
    this.t += dt;
    const t = this.t;
    this.water.material.uniforms.uTime.value = t;
    for (const g of Object.values(this.grids)) g.material.uniforms.uTime.value = t;

    // ships ride the waves: height from the wave function, pitch/roll from its slope
    for (const map of Object.values(this.ships)) {
      for (const e of map.values()) {
        if (e.sinking) continue;
        const p = e.group.position;
        if (e.sunk) { // wrecks rock gently, low in the water
          p.y = WRECK_Y + waveHeight(p.x, p.z, t) * 0.5;
          e.group.rotation.x = e.wreckRoll + Math.sin(t * 0.9 + p.x) * 0.03;
          continue;
        }
        const h = waveHeight(p.x, p.z, t);
        const fwd = new THREE.Vector3(Math.cos(e.yaw), 0, -Math.sin(e.yaw));
        const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
        const len = e.spec.len * 0.4;
        const hf = waveHeight(p.x + fwd.x * len, p.z + fwd.z * len, t), hb = waveHeight(p.x - fwd.x * len, p.z - fwd.z * len, t);
        const hs = waveHeight(p.x + side.x * 0.4, p.z + side.z * 0.4, t), hp = waveHeight(p.x - side.x * 0.4, p.z - side.z * 0.4, t);
        p.y += ((e.dragging ? h + 0.5 : e.spec.type === 'submarine' ? h + 0.02 : h + 0.09) - p.y) * Math.min(1, dt * 8);
        e.group.rotation.z = Math.atan2(hf - hb, len * 2) * 0.8;
        e.group.rotation.x = Math.atan2(hs - hp, 0.8) * 0.8;
        if (e.group.userData.radar) e.group.userData.radar.rotation.y = t * 2.5;
      }
    }
    // markers bob too
    for (const m of this.markers.values()) {
      m.mesh.position.y = waveHeight(m.x, m.z, t) * 0.9;
      const f = m.mesh.userData.flame;
      if (f) f.visible = this.opts.fire;
      if (f && this.opts.fire) f.scale.setScalar(1 + 0.25 * Math.sin(t * 13 + m.seed) + 0.12 * Math.sin(t * 29 + m.seed * 2));
    }

    // burning hits: flickering flames and a slow column of dark smoke
    for (const f of this.fires) {
      f.acc += dt;
      f.smoke = (f.smoke || Math.random() * 0.4) + dt;
      if (f.smoke > 0.45 && this.opts.fire) {
        f.smoke = 0;
        this.puff('smoke', new THREE.Vector3(f.x + rand(-0.1, 0.1), waveHeight(f.x, f.z, t) + 0.8, f.z + rand(-0.1, 0.1)), {
          s0: 0.4, s1: rand(1.8, 2.6), dur: rand(2.6, 3.4), rise: rand(2.6, 3.6), additive: false, opacity: 0.55, drift: { x: rand(0.5, 1.1), z: rand(-0.4, 0) },
        });
      }
      const y = waveHeight(f.x, f.z, t) + 0.35;
      while (f.acc > 0.06) {
        f.acc -= 0.06;
        if (!this.opts.fire) continue;
        this.fireP.spawn({ pos: { x: f.x + rand(-0.15, 0.15), y, z: f.z + rand(-0.15, 0.15) }, vel: { x: rand(-0.15, 0.15), y: rand(0.8, 1.6), z: rand(-0.15, 0.15) }, life: rand(0.35, 0.6), size: [0.5, 0.15], color: [C('#ffd46b'), C('#ff3300')], alpha: [0.9, 0], drag: 1 });
        if (Math.random() < 0.45) this.smokeSpawn({ pos: { x: f.x, y: y + 0.4, z: f.z }, vel: { x: rand(-0.1, 0.25), y: rand(0.6, 1.1), z: rand(-0.2, 0.1) }, life: rand(2, 3), size: [0.4, 1.8], color: [C('#2f2a27'), C('#7c7671')], alpha: [0.5, 0], drag: 0.3 });
      }
    }

    this.anims = this.anims.filter(fn => !fn(dt));
    for (const p of [this.fireP, this.smokeP, this.waterP]) p.update(dt);
    this.flash.intensity *= Math.pow(0.02, dt);

    // camera: chase a missile, or tween between presets; gentle idle drift; impact shake
    if (this.follow) {
      const f = this.follow;
      const flat = new THREE.Vector3(f.dir.x, 0, f.dir.z);
      if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1);
      flat.normalize();
      let wantPos, wantLook;
      if (f.obj) { // behind and above the missile, looking ahead of it toward the target
        const p = f.obj.position;
        // horizontal offset only (a steeply climbing missile would otherwise drag the camera under
        // the sea), and never lower than a couple of metres above the water
        wantPos = p.clone().addScaledVector(flat, -4.2).add(new THREE.Vector3(0, 2.2, 0)).addScaledVector(new THREE.Vector3(-flat.z, 0, flat.x), 0.9);
        wantPos.y = Math.max(wantPos.y, 2.2);
        wantLook = p.clone().addScaledVector(f.dir, 1.5).lerp(f.to, 0.4);
      } else { // impact: a close, slightly raised view of the hit
        wantPos = f.to.clone().addScaledVector(flat, -7).add(new THREE.Vector3(0, 4.6, 0));
        wantLook = f.to.clone().add(new THREE.Vector3(0, 0.4, 0));
      }
      const k = 1 - Math.exp(-dt * (f.obj ? 6 : 3));
      this.camPos.lerp(wantPos, k);
      this.camLook.lerp(wantLook, k);
      this.camFrom = null;
    } else if (this.camFrom) {
      const c = this.camFrom;
      c.t += dt;
      const k = ease(Math.min(c.t / c.dur, 1));
      this.camPos.lerpVectors(c.pos, c.to.pos, k);
      this.camLook.lerpVectors(c.look, c.to.look, k);
      if (k >= 1) { const done = c.done; this.camFrom = null; done?.(); }
    }
    this.camera.position.copy(this.camPos);
    this.camera.position.x += Math.sin(t * 0.21) * 0.25;
    this.camera.position.y += Math.sin(t * 0.33) * 0.12;
    if (this.shakeAmt > 0.001) {
      const s = this.shakeAmt;
      this.camera.position.x += rand(-s, s);
      this.camera.position.y += rand(-s, s) * 0.6;
      this.shakeAmt *= Math.pow(0.004, dt);
    }
    this.camera.lookAt(this.camLook);

    if (this.hover) this.setHighlight(this.hover.grid, this.hover);

    this.composer.render(dt);
    this.adaptQuality(dt);
  }

  // Phones that can't keep up drop bloom and render at a lower resolution.
  adaptQuality(dt) {
    if (this.quality === 'low') return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 120) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 1 / 32) {
      this.quality = 'low';
      this.bloom.enabled = false; // stays off: setOptions checks quality
      this.renderer.setPixelRatio(1);
      this.resize();
    }
  }

  dispose() {
    this.running = false;
    removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVis);
    this.ro.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
