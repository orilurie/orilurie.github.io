// "ניצנוץ" – talking unicorn: 3D scene + animation state machine [SCENE]
// three.js r160 + the CC0 Quaternius horse turned unicorn (unicorn/unicorn-look.js), Poly Haven sky,
// Quaternius meadow, Kenney food props / particles, Fluent Emoji sprites. Credits: unicorn/CREDITS.txt.
//
// createScene(container, {assets, quality:'low'|'high', debug}) → Promise<{setState, react, setMouth, onHit, resize, destroy}>
//   states: idle | listening | talking | sleeping   (happy | dizzy | eating are accepted and mapped to reactions)
//   react : pet | tickle | horn | bonk | eat | wake  (one-shots that return to the current base state by themselves)
//   onHit : cb({part:'head'|'belly'|'horn'|'body', x, y})  x/y in container px
import { UNICORN, NATURE, PROPS, BACKGROUND, SPRITES, FX } from './unicorn/manifest.js';
import { applyUnicornLook } from './unicorn/unicorn-look.js';

const CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/';

/** three + GLTFLoader: the page's importmap if it has one with a loader, else jsDelivr's pinned ESM bundles. */
async function loadThree() {
  try {
    const T = await import('three');
    const G = await import('three/addons/loaders/GLTFLoader.js');
    return { THREE: T, GLTFLoader: G.GLTFLoader };
  } catch {}
  const [T, G] = await Promise.all([import(CDN + '+esm'), import(CDN + 'examples/jsm/loaders/GLTFLoader.js/+esm')]);
  return { THREE: T, GLTFLoader: G.GLTFLoader };
}

/** Average the normals of vertices that share a position (the low-poly horse is flat-shaded; smooth reads cuter). */
function smoothNormals(geo) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  if (!pos || !nor) return;
  const map = new Map(), key = (i) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const acc = [];
  for (let i = 0; i < pos.count; i++) {
    const k = key(i); let a = map.get(k);
    if (!a) { a = [0, 0, 0]; map.set(k, a); }
    a[0] += nor.getX(i); a[1] += nor.getY(i); a[2] += nor.getZ(i); acc.push(a);
  }
  for (let i = 0; i < pos.count; i++) {
    const a = acc[i], l = Math.hypot(a[0], a[1], a[2]) || 1;
    nor.setXYZ(i, a[0] / l, a[1] / l, a[2] / l);
  }
  nor.needsUpdate = true;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const RAINBOW = UNICORN.colors.rainbow;

export async function createScene(container, opts = {}) {
  const quality = opts.quality === 'low' ? 'low' : 'high';
  const HQ = quality === 'high';
  const { THREE, GLTFLoader } = await loadThree();
  const V3 = THREE.Vector3;

  // ------------------------------------------------------------------ renderer
  const renderer = new THREE.WebGLRenderer({ antialias: HQ, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: !!opts.debug });
  const maxPR = HQ ? 2 : 1.5;
  let pixelRatio = Math.min(window.devicePixelRatio || 1, maxPR);
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = HQ ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.touchAction = 'none';
  container.querySelectorAll('canvas').forEach((c) => c.remove());
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const C = UNICORN.colors;
  scene.background = new THREE.Color(C.sky);
  scene.fog = new THREE.Fog(C.fog, 18, 45);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 120);

  // ------------------------------------------------------------------ loading
  const texLoader = new THREE.TextureLoader();
  const loadTex = (url) => new Promise((res) => texLoader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; res(t); }, undefined, () => res(null)));
  const gltfLoader = new GLTFLoader();
  const loadGltf = (url) => new Promise((res) => gltfLoader.load(url, res, undefined, (e) => { console.warn('[unicorn-scene] load failed', url, e); res(null); }));
  const spriteNames = ['pink_heart', 'sparkling_heart', 'growing_heart', 'zzz', 'star', 'glowing_star', 'dizzy', 'rainbow', 'sparkles', 'musical_notes'];
  const fxNames = ['light_01', 'circle_05', 'magic_02', 'magic_05', 'star_04', 'star_06', 'star_07', 'star_08', 'flare_01', 'twirl_02'];
  const [uniG, natG, propG, sky, ...texs] = await Promise.all([
    loadGltf(UNICORN.model), loadGltf(NATURE.file), loadGltf(PROPS.file), loadTex(BACKGROUND.sky),
    ...spriteNames.map((n) => loadTex(SPRITES[n])), ...fxNames.map((n) => loadTex(FX[n])),
  ]);
  if (!uniG) throw new Error('unicorn model failed to load');
  const TEX = {};
  spriteNames.forEach((n, i) => { TEX[n] = texs[i]; });
  fxNames.forEach((n, i) => { TEX[n] = texs[spriteNames.length + i]; });

  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };

  if (sky) {
    sky.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = sky;
    disposables.push(sky);
  }

  // ------------------------------------------------------------------ lights (soft, warm key + pastel rim)
  const hemi = new THREE.HemisphereLight('#fff4fa', '#8cc779', 1.05);
  scene.add(hemi);
  const key = new THREE.DirectionalLight('#fff0dc', 2.6);
  key.position.set(3.2, 7, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(HQ ? 2048 : 1024, HQ ? 2048 : 1024);
  Object.assign(key.shadow.camera, { left: -2.6, right: 2.6, top: 2.6, bottom: -2.6, near: 1, far: 20 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 4;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight('#ffc4f0', 1.4);
  rim.position.set(-4, 3.5, -5);
  scene.add(rim);
  const fill = new THREE.DirectionalLight('#cfe3ff', 0.55);
  fill.position.set(-5, 2, 4);
  scene.add(fill);

  // ------------------------------------------------------------------ ground + meadow
  const groundGeo = keep(new THREE.CircleGeometry(60, 64));
  {
    const pos = groundGeo.attributes.position, col = new Float32Array(pos.count * 3);
    const a = new THREE.Color(C.grass), b = new THREE.Color(C.grassDark), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      c.copy(a).lerp(b, smooth((r - 2) / 14) * 0.55);
      col.set([c.r, c.g, c.b], i * 3);
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const ground = new THREE.Mesh(groundGeo, keep(new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 1, metalness: 0 })));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // soft contact shadow under the unicorn (a radial gradient made in code; adds weight even when shadow maps are soft)
  const blobTex = (() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g = cv.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(60,40,90,0.55)'); gr.addColorStop(0.55, 'rgba(60,40,90,0.22)'); gr.addColorStop(1, 'rgba(60,40,90,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return keep(t);
  })();
  const blob = new THREE.Mesh(keep(new THREE.PlaneGeometry(1, 1)), keep(new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, toneMapped: false })));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.004; blob.scale.set(1.9, 1.25, 1); blob.renderOrder = 1;
  scene.add(blob);

  if (natG) buildMeadow(natG.scene);
  function buildMeadow(src) {
    src.updateMatrixWorld(true);
    let seed = 11;
    const r01 = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const I = NATURE.items;
    // cheap kinds most often (tris: grass 155–326, fern 288, clover 379, flower_3 755, flower_4 1690)
    const small = ['Grass_Common_Short', 'Flower_3_Group', 'Grass_Common_Tall', 'Clover_1', 'Flower_3_Group', 'Grass_Common_Short', 'Fern_1', 'Flower_4_Group', 'Grass_Common_Short', 'Flower_3_Group', 'Clover_1', 'Bush_Common_Flowers'];
    const place = {};   // kind → [Matrix4]
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V3(), p = new V3(), up = new V3(0, 1, 0);
    const add = (k, x, z, sc, ry) => {
      if (!I[k] || !src.getObjectByName(k)) return;
      q.setFromAxisAngle(up, ry); s.setScalar(sc); p.set(x, 0, z);
      (place[k] ||= []).push(new THREE.Matrix4().compose(p, q, s));
    };
    const N = HQ ? 180 : 80;
    for (let i = 0; i < N; i++) {
      const k = small[i % small.length];
      const ang = r01() * Math.PI * 2, rad = 1.5 + Math.pow(r01(), 0.75) * 12;
      const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad - 2;
      if (z > 1.2 && Math.abs(x) < 2.2) continue;             // keep the camera side clear
      if (Math.hypot(x, z) < 1.45) continue;                     // and the unicorn's feet
      add(k, x, z, I[k][0] * (0.75 + r01() * 0.55), r01() * 6.28);
    }
    const trees = HQ ? 9 : 6;
    for (let i = 0; i < trees; i++) {
      const tree = i % 2 === 1;
      const k = tree ? 'CommonTree_3' : (i % 4 === 0 ? 'Bush_Common_Flowers' : 'Bush_Common');
      const ang = -Math.PI / 2 + (i / (trees - 1) - 0.5) * 2.9 + (r01() - 0.5) * 0.15;
      const rad = tree ? 14 + r01() * 3 : 11.5 + r01() * 2;
      add(k, Math.cos(ang) * rad, Math.sin(ang) * rad, I[k][0] * (tree ? 0.9 + r01() * 0.35 : 1.5 + r01() * 0.4), r01() * 6.28);
    }
    const inv = new THREE.Matrix4(), rel = new THREE.Matrix4();
    for (const [k, list] of Object.entries(place)) {
      const node = src.getObjectByName(k);
      inv.copy(node.matrixWorld).invert();
      node.traverse((m) => {
        if (!m.isMesh) return;
        rel.multiplyMatrices(inv, m.matrixWorld);
        const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((mt) => {
          const c = mt.clone(); c.metalness = 0;
          if (c.map || c.alphaTest > 0 || c.transparent) { c.alphaTest = Math.max(c.alphaTest, 0.5); c.transparent = false; c.side = THREE.DoubleSide; }
          return keep(c);
        });
        const im = new THREE.InstancedMesh(m.geometry, mats.length === 1 ? mats[0] : mats, list.length);
        list.forEach((mx, i) => im.setMatrixAt(i, m4.multiplyMatrices(mx, rel)));
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = false; im.receiveShadow = HQ && k.startsWith('Bush');
        im.frustumCulled = false;
        keep(m.geometry);
        scene.add(im);
      });
    }
  }

  // ------------------------------------------------------------------ the unicorn
  const model = uniG.scene;
  const look = applyUnicornLook(model, THREE);
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = HQ;
    if (o.isSkinnedMesh) smoothNormals(o.geometry);
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      // a soft pink "subsurface" lift so the white coat reads pastel instead of grey in the shade
      if (m.name === 'Main' || m.name === 'Main_Light' || m.name === 'Muzzle') { m.emissive.set(m.name === 'Main_Light' ? '#e6d4ff' : '#ffd3ee'); m.emissiveIntensity = 0.16; }
      if (m.name === 'Hair') { m.emissive.set('#ffffff'); m.emissiveIntensity = 0.08; }
    });
  });
  const MODEL_SCALE = 0.33, BASE_YAW = UNICORN.frontYaw;
  model.scale.setScalar(MODEL_SCALE);
  model.rotation.y = BASE_YAW;
  const pivot = new THREE.Group();   // squash / breathing / hops happen here (world axes)
  pivot.add(model);
  scene.add(pivot);
  const bone = (n) => model.getObjectByName(n);
  const head = look.head, neck = look.neck, ears = look.ears, tail = look.tail;
  const torso = bone('Torso');
  const earRest = { L: ears.L.map((b) => b && b.quaternion.clone()), R: ears.R.map((b) => b && b.quaternion.clone()) };

  // animation clips
  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const clip of uniG.animations) actions[clip.name] = mixer.clipAction(clip);
  let curAction = null, curName = '';
  function play(name, { loop = true, fade = 0.35, ts = 1, clampEnd = false, from = 0 } = {}) {
    const a = actions[name];
    if (!a) return null;
    if (a === curAction && loop && a.loop === THREE.LoopRepeat) { a.timeScale = ts; return a; }
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    a.clampWhenFinished = clampEnd;
    a.timeScale = ts;
    a.time = from;
    a.setEffectiveWeight(1);
    if (curAction && curAction !== a) { a.crossFadeFrom(curAction, fade, false); } else a.fadeIn(fade);
    a.play();
    curAction = a; curName = name;
    return a;
  }

  // Sample the Eating clip once to find when/where the snout is lowest (the food lands there).
  const eatInfo = { t: 1.2, local: new V3(0.18, 0.05, 0.9) };
  {
    const a = actions.Eating;
    if (a) {
      a.play(); let best = Infinity;
      const tip = new V3();
      for (let t = 0; t < (a.getClip().duration || 6); t += 0.1) {
        mixer.setTime(t); model.updateMatrixWorld(true); look.update(0);
        tip.set(...UNICORN.headLocal.snoutTip); head.localToWorld(tip);
        if (tip.y < best) { best = tip.y; eatInfo.t = t; eatInfo.local.copy(tip); }
      }
      a.stop(); mixer.setTime(0);
    }
  }

  // ------------------------------------------------------------------ props (food that flies in)
  const foods = [];
  if (propG) {
    for (const n of ['cupcake', 'donut-sprinkles', 'lollypop', 'strawberry', 'cookie', 'apple', 'candy-bar', 'carrot']) {
      const src = propG.scene.getObjectByName(n);
      if (!src) continue;
      const g = new THREE.Group(), o = src.clone(true);
      o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
      o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.material = m.material.clone(); m.material.metalness = 0; keep(m.material); } });
      const box = new THREE.Box3().setFromObject(o), size = box.getSize(new V3()), ctr = box.getCenter(new V3());
      const k = 0.3 / Math.max(size.x, size.y, size.z);
      o.position.set(-ctr.x * k, -box.min.y * k, -ctr.z * k); o.scale.setScalar(k);
      g.add(o); g.visible = false; g.name = n;
      scene.add(g); foods.push(g);
    }
  }
  let foodIdx = 0;

  // ------------------------------------------------------------------ particles
  // Two pools: additive glows (Kenney fx, tinted) and normal emoji sprites (hearts, zzz, stars, rainbow).
  function makePool(n, additive) {
    const list = [];
    for (let i = 0; i < n; i++) {
      const mat = keep(new THREE.SpriteMaterial({
        transparent: true, depthWrite: false, depthTest: true, fog: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: !additive,
      }));
      const s = new THREE.Sprite(mat); s.visible = false; s.renderOrder = additive ? 20 : 10;
      scene.add(s);
      list.push({ s, mat, on: false, age: 0, life: 1, vel: new V3(), grav: 0, drag: 0, size0: 0.1, size1: 0.1, spin: 0, fadeIn: 0.08, op: 1, follow: null, wob: 0, ph: 0 });
    }
    return list;
  }
  const poolAdd = makePool(HQ ? 140 : 80, true), poolEmo = makePool(HQ ? 40 : 28, false);
  const tmpC = new THREE.Color();
  function spawn(o) {
    const pool = o.additive ? poolAdd : poolEmo;
    let p = pool.find((x) => !x.on);
    if (!p) p = pool.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
    const tex = TEX[o.tex];
    if (!tex) return null;
    p.on = true; p.age = 0; p.life = o.life || 1;
    p.s.position.copy(o.pos);
    p.vel.copy(o.vel || new V3());
    p.grav = o.grav || 0; p.drag = o.drag || 0;
    p.size0 = o.size0 ?? 0.15; p.size1 = o.size1 ?? p.size0;
    p.spin = o.spin || 0; p.fadeIn = o.fadeIn ?? 0.08; p.op = o.opacity ?? 1;
    p.wob = o.wob || 0; p.ph = Math.random() * 6.28;
    p.mat.map = tex; p.mat.rotation = o.rot ?? (o.additive ? Math.random() * 6.28 : rnd(-0.25, 0.25));
    p.mat.color.set(o.color || '#ffffff');
    p.mat.depthTest = o.front ? false : true;
    p.s.renderOrder = o.front ? 30 : o.additive ? 20 : 10;
    p.mat.needsUpdate = true;
    p.s.visible = true;
    p.s.scale.setScalar(p.size0);
    return p;
  }
  function updatePool(pool, dt) {
    for (const p of pool) {
      if (!p.on) continue;
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) { p.on = false; p.s.visible = false; continue; }
      p.vel.y -= p.grav * dt;
      if (p.drag) p.vel.multiplyScalar(Math.exp(-p.drag * dt));
      p.s.position.addScaledVector(p.vel, dt);
      if (p.wob) p.s.position.x += Math.sin(p.age * 5 + p.ph) * p.wob * dt;
      p.mat.rotation += p.spin * dt;
      const sz = lerp(p.size0, p.size1, 1 - (1 - t) * (1 - t));
      p.s.scale.setScalar(sz);
      const fi = p.fadeIn > 0 ? clamp(p.age / p.fadeIn, 0, 1) : 1;
      p.mat.opacity = p.op * fi * (t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1);
    }
  }
  // camera-facing helpers for bursts in the screen plane
  const camRight = new V3(), camUp = new V3(), camFwd = new V3();
  function camBasis() {
    camera.updateMatrixWorld();
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    camUp.setFromMatrixColumn(camera.matrixWorld, 1);
    camFwd.setFromMatrixColumn(camera.matrixWorld, 2).negate();
  }
  function sparkle(pos, n = 10, spread = 0.9, colors = RAINBOW) {
    camBasis();
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, sp = rnd(0.3, 1) * spread;
      const v = new V3().addScaledVector(camRight, Math.cos(a) * sp).addScaledVector(camUp, Math.sin(a) * sp + 0.25);
      const col = pick(colors);
      spawn({ additive: true, tex: 'light_01', pos, vel: v, drag: 2.2, grav: -0.1, life: rnd(0.6, 1.0), size0: 0.22, size1: 0.02, color: col, opacity: 0.55 });
      spawn({ additive: true, tex: pick(['star_04', 'star_06', 'star_07', 'star_08']), pos, vel: v, drag: 2.2, grav: -0.1, life: rnd(0.7, 1.1), size0: rnd(0.08, 0.14), size1: 0.02, spin: rnd(-3, 3), color: '#ffffff', opacity: 1 });
    }
  }
  function hearts(pos, n = 4, spread = 0.25) {
    camBasis();
    for (let i = 0; i < n; i++) {
      const v = new V3().addScaledVector(camRight, rnd(-0.4, 0.4)).addScaledVector(camUp, rnd(0.45, 0.8));
      const p = new V3().copy(pos).addScaledVector(camRight, rnd(-spread, spread)).addScaledVector(camUp, rnd(-0.05, 0.1));
      spawn({ tex: pick(['pink_heart', 'sparkling_heart', 'growing_heart', 'pink_heart']), pos: p, vel: v, drag: 0.6, life: rnd(1.1, 1.6), size0: 0.05, size1: rnd(0.16, 0.24), wob: 0.5, front: true });
    }
  }

  // ambient pixie dust drifting around the unicorn
  const motes = [];
  for (let i = 0; i < (HQ ? 26 : 12); i++) {
    const mat = keep(new THREE.SpriteMaterial({ map: TEX.light_01, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false }));
    mat.color.set(pick(RAINBOW));
    const s = new THREE.Sprite(mat); s.renderOrder = 19;
    const m = { s, mat, a: Math.random() * 6.28, r: rnd(0.9, 2.2), h: rnd(0.2, 2.0), sp: rnd(0.08, 0.22) * (Math.random() < 0.5 ? -1 : 1), ph: Math.random() * 6.28, sz: rnd(0.05, 0.11) };
    scene.add(s); motes.push(m);
  }
  // soft glow on the horn tip
  const hornGlow = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: TEX.light_01, color: '#ffd9f4', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.5 })));
  hornGlow.renderOrder = 21;
  scene.add(hornGlow);
  const hornMat = look.horn.material;
  if (sky) { hornMat.envMap = sky; hornMat.envMapIntensity = 0.9; hornMat.needsUpdate = true; }
  const hornEmissive = hornMat.emissive.clone();

  // dizzy stars orbit the head
  const dizzyStars = [];
  for (let i = 0; i < 5; i++) {
    const mat = keep(new THREE.SpriteMaterial({ map: TEX[i % 2 ? 'dizzy' : 'star'], transparent: true, depthWrite: false, opacity: 0 }));
    const s = new THREE.Sprite(mat); s.renderOrder = 25; s.visible = false;
    scene.add(s); dizzyStars.push(s);
  }

  // ------------------------------------------------------------------ framing / camera
  let W = 1, H = 1;
  const frame = { target: new V3(-0.22, 0.86, 0.1), dist: 5.2, elev: 0.16 };
  function resize() {
    W = Math.max(1, container.clientWidth || window.innerWidth);
    H = Math.max(1, container.clientHeight || window.innerHeight);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    // keep the unicorn in the area between the top bar (~60 px) and the bottom bar (~170 px portrait, ~90 px landscape phones)
    const landscape = W > H && H < 560;
    const top = 62, bot = landscape ? 96 : 176;
    const safeH = Math.max(120, H - top - bot);
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const uniH = 1.75, uniW = 1.85;                         // horn tip to hooves, apparent width at 3/4 view (+ margin)
    const dV = (uniH * H) / (0.86 * safeH * 2 * tan);
    const dH = uniW / (0.92 * 2 * tan * camera.aspect);
    frame.dist = clamp(Math.max(dV, dH), 3.6, 9);
    camera.setViewOffset(W, H, 0, (bot - top) / 2, W, H);
    camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ state machine
  let base = 'idle';           // idle | listening | talking | sleeping
  let rx = null;               // current reaction {kind, t, dur, ...}
  let stateT = 0, time = 0;
  let idleClipT = rnd(7, 11), nextLookT = rnd(1.5, 3), nextYawnT = rnd(14, 22), nextTwitchT = rnd(2, 5);
  let yawnT = -1;
  let mouthLevel = 0, mouthSm = 0;
  const lookTgt = { yaw: 0, pitch: 0, hold: 0 }, lookCur = { yaw: 0, pitch: 0 };
  let eyeK = 0, eyeTarget = 0, eyesWereClosed = false;
  let earPerk = 0, tiltCur = 0;
  let sq = 0, sqV = 0;         // squash spring (+ = stretch)
  let hop = 0, hopV = 0;
  let zzzT = 0;
  let dizzyAmt = 0;
  const food = { g: null, t: -1, from: new V3(), to: new V3(), bites: 0 };
  let camPull = 0, camShake = 0;

  function baseClip(fade = 0.45) {
    if (base === 'sleeping') { play('Death', { loop: false, clampEnd: true, ts: 0.35, fade: 0.6 }); return; }
    if (base === 'listening') { play('Idle', { ts: 0.75, fade }); return; }
    if (base === 'talking') { play('Idle', { ts: 1.1, fade }); return; }
    play(curName && ['Idle', 'Idle_2', 'Idle_Headlow'].includes(curName) ? curName : 'Idle', { fade });
  }

  function setState(s) {
    if (s === 'happy') return react('pet');
    if (s === 'dizzy') return react('bonk');
    if (s === 'eating') return react('eat');
    if (!['idle', 'listening', 'talking', 'sleeping'].includes(s)) return;
    if (s === base) return;
    const was = base;
    base = s; stateT = 0;
    if (s !== 'talking') mouthLevel = 0;
    if (s === 'sleeping') { yawnT = -1; zzzT = 0.8; }
    if (was === 'sleeping' && s !== 'sleeping' && (!rx || rx.kind !== 'wake')) wakeUp();
    if (!rx) baseClip();
  }

  function wakeUp() {
    eyeTarget = 0;
    const hp = headWorld(new V3());
    sparkle(hp.add(new V3(0, 0.15, 0)), 8, 0.7);
  }

  const REACT_DUR = { pet: 1.5, tickle: 1.5, horn: 1.8, bonk: 2.7, eat: 2.6, wake: 1.4 };
  function react(kind) {
    if (!REACT_DUR[kind]) return;
    if (rx && rx.kind === 'bonk' && kind !== 'bonk' && rx.t < 1.4) return;   // let the bonk land
    if (kind === 'eat' && rx && rx.kind === 'eat') return;
    if (base === 'sleeping' && kind !== 'wake') base = 'idle';
    endFood();
    rx = { kind, t: 0, dur: REACT_DUR[kind], fired: {} };
    const hp = headWorld(new V3());
    switch (kind) {
      case 'pet':
        play('Jump_toIdle', { loop: false, fade: 0.2, ts: 1.15, from: 0.15 });
        hopV = 1.6; sqV = -1.2;
        hearts(hp.clone().add(new V3(0, 0.2, 0)), 5);
        break;
      case 'tickle':
        play('Attack_Kick', { loop: false, fade: 0.15, ts: 0.9 });
        sqV = 2.6;
        sparkle(bellyWorld(new V3()), 8, 0.9, ['#ffffff', '#ffe0f4', '#fff3a8']);
        hearts(bellyWorld(new V3()).add(new V3(0, 0.1, 0)), 3, 0.3);
        break;
      case 'horn':
        play('Jump_toIdle', { loop: false, fade: 0.2, ts: 0.9, from: 0.1 });
        hornBurst();
        break;
      case 'bonk':
        play(Math.random() < 0.5 ? 'Idle_HitReact_Right' : 'Idle_HitReact_Left', { loop: false, fade: 0.08, ts: 0.85 });
        sq = -0.3; sqV = 0; camShake = 0.12;
        spawn({ tex: 'glowing_star', pos: hp.clone().add(new V3(0, 0.28, 0)), life: 0.45, size0: 0.15, size1: 0.45, front: true, fadeIn: 0.02 });
        sparkle(hp.clone().add(new V3(0, 0.2, 0)), 6, 1.2, ['#fff7a0', '#ffffff', '#ffd36e']);
        break;
      case 'eat':
        startFood();
        break;
      case 'wake':
        eyeTarget = 0;
        play('Jump_toIdle', { loop: false, fade: 0.5, ts: 0.9, from: 0.2 });
        sqV = 1.4;
        sparkle(hp.clone().add(new V3(0, 0.25, 0)), 8, 0.8);
        break;
    }
  }

  function endReact() {
    rx = null;
    baseClip(0.5);
  }

  // ---------- horn burst
  function hornTip(v) { return look.horn.localToWorld(v.set(0, UNICORN.look.horn.length, 0)); }
  function hornBurst() {
    const tip = hornTip(new V3());
    camBasis();
    spawn({ additive: true, tex: 'flare_01', pos: tip, life: 0.5, size0: 0.4, size1: 1.4, color: '#ffffff', opacity: 0.9, fadeIn: 0.01, front: true });
    spawn({ additive: true, tex: 'magic_02', pos: tip, life: 1.0, size0: 0.15, size1: 1.5, spin: 2.5, color: '#ffb3ec', opacity: 0.9, fadeIn: 0.02, front: true });
    rx.fired.ring2 = false;
    for (let i = 0; i < (HQ ? 36 : 24); i++) {
      const a = (i / (HQ ? 36 : 24)) * 6.28 + rnd(-0.1, 0.1), sp = rnd(1.0, 1.9);
      const v = new V3().addScaledVector(camRight, Math.cos(a) * sp).addScaledVector(camUp, Math.sin(a) * sp + 0.4);
      const col = RAINBOW[i % RAINBOW.length];
      spawn({ additive: true, tex: 'light_01', pos: tip, vel: v, drag: 2.4, grav: 0.4, life: rnd(0.9, 1.3), size0: 0.28, size1: 0.04, color: col, opacity: 0.75, front: true });
      spawn({ additive: true, tex: pick(['star_06', 'star_07', 'star_08']), pos: tip, vel: v, drag: 2.4, grav: 0.4, life: rnd(1.0, 1.4), size0: 0.13, size1: 0.03, spin: rnd(-4, 4), color: col, opacity: 1, front: true });
    }
    const rb = tip.clone().addScaledVector(camUp, 0.3);
    spawn({ tex: 'rainbow', pos: rb, vel: camUp.clone().multiplyScalar(0.25), life: 1.7, size0: 0.2, size1: 0.85, front: true, fadeIn: 0.15, rot: 0 });
  }

  // ---------- food
  function startFood() {
    if (!foods.length) { play('Eating', { loop: true, fade: 0.3, from: Math.max(0, eatInfo.t - 0.7) }); return; }
    const g = foods[foodIdx++ % foods.length];
    model.updateMatrixWorld(true);
    // landing spot: where the snout is lowest in the Eating clip (model space → world)
    const land = eatInfo.local.clone();
    pivot.localToWorld(land);
    land.y = 0;
    food.g = g; food.t = 0; food.bites = 0;
    food.to.copy(land);
    camBasis();
    food.from.copy(camera.position).addScaledVector(camFwd, 1.2).addScaledVector(camUp, -0.55).addScaledVector(camRight, 0.35);
    g.visible = true; g.scale.setScalar(1); g.position.copy(food.from);
    play('Idle', { fade: 0.2 });
  }
  function endFood() {
    if (food.g) food.g.visible = false;
    food.g = null; food.t = -1;
  }
  function updateFood(dt) {
    if (!food.g) return;
    food.t += dt;
    const g = food.g, FLY = 0.55;
    if (food.t < FLY) {
      const k = food.t / FLY, e = 1 - (1 - k) * (1 - k);
      g.position.lerpVectors(food.from, food.to, e);
      g.position.y += Math.sin(k * Math.PI) * 0.55;
      g.rotation.set(k * 4, k * 6, 0);
      const s = 0.7 + 0.3 * k; g.scale.setScalar(s);
      if (Math.random() < 0.5) spawn({ additive: true, tex: 'light_01', pos: g.position.clone().add(new V3(0, 0.1, 0)), life: 0.4, size0: 0.14, size1: 0.02, color: pick(RAINBOW), opacity: 0.7 });
    } else {
      if (!rx.fired.land) {
        rx.fired.land = true;
        g.position.copy(food.to); g.rotation.set(0, rnd(0, 6.28), 0);
        sq = 0; sqV = 0.8;
        play('Eating', { loop: true, fade: 0.25, ts: 1.25, from: Math.max(0, eatInfo.t - 0.45) });
        sparkle(food.to.clone().add(new V3(0, 0.15, 0)), 5, 0.6, ['#ffffff', '#fff3a8']);
      }
      // two bites (matching the shell's munch SFX at ~0.7 s and ~1.1 s), then gone
      const bites = [0.75, 1.15, 1.6];
      while (food.bites < bites.length && food.t >= bites[food.bites]) {
        food.bites++;
        const s = [0.72, 0.45, 0][food.bites - 1];
        g.scale.setScalar(Math.max(0.001, s));
        g.position.y = food.to.y;
        const cp = food.to.clone().add(new V3(0, 0.12, 0));
        for (let i = 0; i < 6; i++) spawn({ additive: true, tex: 'circle_05', pos: cp, vel: new V3(rnd(-0.6, 0.6), rnd(0.4, 1.0), rnd(-0.6, 0.6)), grav: 3, life: 0.5, size0: 0.05, size1: 0.03, color: pick(['#ffd1e8', '#fff2c0', '#c8a07a']), opacity: 0.9 });
        if (food.bites === 3) { g.visible = false; }
      }
      if (food.t > 1.75 && !rx.fired.yum) {
        rx.fired.yum = true;
        play('Jump_toIdle', { loop: false, fade: 0.35, ts: 1, from: 0.25 });
        hearts(headWorld(new V3()).add(new V3(0, 0.2, 0)), 4);
      }
    }
  }

  // ------------------------------------------------------------------ geometry helpers
  const HL = UNICORN.headLocal;
  const headCenterLocal = new V3(...HL.hitHead.center);
  function headWorld(v) { return head.localToWorld(v.copy(headCenterLocal)); }
  const bellyLocal = new V3(...UNICORN.hitBelly.center);
  function bellyWorld(v) { return model.localToWorld(v.copy(bellyLocal)); }
  const tmpV = new V3(), tmpV2 = new V3(), tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion();
  const AX = new V3(1, 0, 0), AY = new V3(0, 1, 0), AZ = new V3(0, 0, 1);
  function rotLocal(b, axis, ang) { if (b && ang) b.quaternion.multiply(tmpQ.setFromAxisAngle(axis, ang)); }
  function worldScale(o) { return o.getWorldScale(tmpV2).x; }

  // ------------------------------------------------------------------ hit testing
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hitCbs = [];
  const pickMeshes = [];
  model.traverse((o) => { if (o.isMesh && o.visible && o.name !== 'Mouth') pickMeshes.push(o); });
  function hitTest(cx, cy) {
    const r = canvas.getBoundingClientRect();
    const x = cx - r.left, y = cy - r.top;
    ndc.set((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1);
    camera.updateMatrixWorld();
    ray.setFromCamera(ndc, camera);
    model.updateMatrixWorld(true);
    const R = ray.ray;
    // horn: distance from the ray to the horn segment (fat-finger friendly)
    const hb = look.horn.localToWorld(new V3(0, 0, 0)), ht = hornTip(new V3());
    const segD2 = R.distanceSqToSegment(hb, ht);
    const hs = worldScale(head);
    const headC = headWorld(new V3()), headR = HL.hitHead.radius * hs;
    const bellyC = bellyWorld(new V3()), bellyR = UNICORN.hitBelly.radius * MODEL_SCALE;
    if (segD2 < (0.085) ** 2) return { part: 'horn', x, y, point: ht };
    // precise: the skinned mesh
    for (const m of pickMeshes) if (m.isSkinnedMesh) m.boundingSphere = null;
    const hits = ray.intersectObjects(pickMeshes, false);
    if (hits.length) {
      const p = hits[0].point;
      if (hits[0].object.parent && (hits[0].object.parent.name || '').startsWith('Eye')) return { part: 'head', x, y, point: p };
      if (p.distanceTo(headC) < headR * 1.05) return { part: 'head', x, y, point: p };
      if (p.distanceTo(bellyC) < bellyR * 1.1) return { part: 'belly', x, y, point: p };
      return { part: 'body', x, y, point: p };
    }
    // forgiving spheres around the head and belly
    if (R.distanceSqToPoint(headC) < (headR * 1.15) ** 2) return { part: 'head', x, y, point: headC };
    if (R.distanceSqToPoint(bellyC) < (bellyR * 1.05) ** 2) return { part: 'belly', x, y, point: bellyC };
    return { part: null, x, y, point: R.at(frame.dist, new V3()) };
  }
  let down = null;
  const onDown = (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; };
  const onUp = (e) => {
    if (!down || down.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
    down = null;
    if (moved > 18 || dt > 700) return;
    const h = hitTest(e.clientX, e.clientY);
    lookAtPoint(h.point, 1.6);
    if (!h.part) return;
    const out = { part: h.part, x: Math.round(h.x), y: Math.round(h.y) };
    for (const cb of hitCbs) { try { cb(out); } catch (err) { console.error(err); } }
  };
  canvas.addEventListener('pointerdown', onDown, { passive: true });
  canvas.addEventListener('pointerup', onUp, { passive: true });

  // look toward a world point: yaw/pitch relative to the unicorn's facing, from the head
  const invModel = new THREE.Matrix4();
  function lookAtPoint(pt, hold = 1.5) {
    if (!pt) return;
    model.updateMatrixWorld(true);
    invModel.copy(model.matrixWorld).invert();
    const lp = tmpV.copy(pt).applyMatrix4(invModel);
    const hp = head.getWorldPosition(new V3()).applyMatrix4(invModel);
    const d = lp.sub(hp);
    lookTgt.yaw = clamp(Math.atan2(d.x, d.z), -0.75, 0.75);
    lookTgt.pitch = clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.45, 0.4);
    lookTgt.hold = hold;
  }
  const camLookYaw = () => { // yaw toward the camera, in model terms
    model.updateMatrixWorld(true);
    invModel.copy(model.matrixWorld).invert();
    const lp = tmpV.copy(camera.position).applyMatrix4(invModel);
    const hp = head.getWorldPosition(new V3()).applyMatrix4(invModel);
    const d = lp.sub(hp);
    return { yaw: clamp(Math.atan2(d.x, d.z), -0.75, 0.75), pitch: clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.3, 0.3) };
  };

  // ------------------------------------------------------------------ per-frame update
  function update(dt) {
    time += dt; stateT += dt;
    const sleeping = base === 'sleeping' && !(rx && rx.kind === 'wake');

    // ---- reactions timeline
    if (rx) {
      rx.t += dt;
      if (rx.kind === 'horn' && !rx.fired.ring2 && rx.t > 0.18) {
        rx.fired.ring2 = true;
        spawn({ additive: true, tex: 'magic_05', pos: hornTip(new V3()), life: 1.0, size0: 0.2, size1: 1.9, spin: -2, color: '#b8e6ff', opacity: 0.85, fadeIn: 0.02, front: true });
      }
      if (rx.kind === 'horn' && rx.t < 1.2 && Math.random() < 0.6) {
        spawn({ additive: true, tex: pick(['star_04', 'star_08']), pos: hornTip(new V3()), vel: new V3(rnd(-0.4, 0.4), rnd(0.2, 0.7), rnd(-0.4, 0.4)), life: 0.7, size0: 0.1, size1: 0.02, color: pick(RAINBOW), spin: 3 });
      }
      if (rx.kind === 'pet' && !rx.fired.h2 && rx.t > 0.5) { rx.fired.h2 = true; hearts(headWorld(new V3()).add(new V3(0, 0.25, 0)), 3); }
      if (rx.kind === 'tickle' && !rx.fired.t2 && rx.t > 0.55) { rx.fired.t2 = true; sqV = 2.2; sparkle(bellyWorld(new V3()), 5, 0.8, ['#ffffff', '#ffe0f4', '#fff3a8']); }
      if (rx.kind === 'bonk' && !rx.fired.dz && rx.t > 0.35) { rx.fired.dz = true; play('Idle', { fade: 0.5, ts: 0.7 }); }
      if (rx.kind === 'eat') updateFood(dt);
      if (rx.t >= rx.dur) { if (rx.kind === 'eat') endFood(); endReact(); }
    }

    // ---- base-state behaviour
    if (!rx) {
      if (base === 'idle') {
        idleClipT -= dt;
        if (idleClipT <= 0) {
          idleClipT = rnd(7, 12);
          const r = Math.random();
          play(r < 0.5 ? 'Idle' : r < 0.82 ? 'Idle_2' : 'Idle_Headlow', { fade: 0.8 });
        }
        nextYawnT -= dt;
        if (nextYawnT <= 0 && yawnT < 0) { yawnT = 0; nextYawnT = rnd(16, 26); }
      }
    }
    if (yawnT >= 0) { yawnT += dt; if (yawnT > 2.4 || rx || base !== 'idle') yawnT = -1; }

    // ---- look target
    lookTgt.hold -= dt;
    if (lookTgt.hold <= 0) {
      if (base === 'listening' || base === 'talking') { const c = camLookYaw(); lookTgt.yaw = c.yaw * 0.85; lookTgt.pitch = c.pitch; lookTgt.hold = 0.5; }
      else if (sleeping || (rx && (rx.kind === 'eat' || rx.kind === 'bonk'))) { lookTgt.yaw = 0; lookTgt.pitch = 0; lookTgt.hold = 0.3; }
      else if ((nextLookT -= dt) <= 0) {
        nextLookT = rnd(2.2, 4.5);
        if (Math.random() < 0.45) { const c = camLookYaw(); lookTgt.yaw = c.yaw * 0.8; lookTgt.pitch = c.pitch * 0.6; }
        else { lookTgt.yaw = rnd(-0.6, 0.6); lookTgt.pitch = rnd(-0.12, 0.25); }
        lookTgt.hold = rnd(1.2, 2.4);
      }
    }
    const lookW = sleeping ? 0 : (rx && (rx.kind === 'eat' && food.t > 0.5)) ? 0.15 : 1;
    lookCur.yaw = damp(lookCur.yaw, lookTgt.yaw * lookW, 5, dt);
    lookCur.pitch = damp(lookCur.pitch, lookTgt.pitch * lookW, 5, dt);

    // ---- skeletal animation
    mixer.update(dt);

    // ---- procedural layers on top of the clip pose
    // head look (spread over the neck), listening tilt, talking nod, yawn, dizzy wobble
    const listening = base === 'listening' && !rx;
    tiltCur = damp(tiltCur, listening ? 0.32 : (rx && rx.kind === 'pet') ? -0.25 : 0, 4, dt);
    earPerk = damp(earPerk, listening ? 1 : sleeping ? -0.7 : 0, 5, dt);
    dizzyAmt = damp(dizzyAmt, rx && rx.kind === 'bonk' && rx.t > 0.2 && rx.t < 2.4 ? 1 : 0, 6, dt);
    mouthSm = damp(mouthSm, base === 'talking' ? mouthLevel : 0, 18, dt);

    let yaw = lookCur.yaw, pitch = lookCur.pitch, tilt = tiltCur, mouth = mouthSm;
    // breathing nod / talking nod
    const breathe = Math.sin(time * (sleeping ? 1.6 : 2.4));
    pitch += breathe * 0.015;
    if (base === 'talking') { pitch -= mouthSm * 0.28; tilt += Math.sin(time * 3.1) * 0.06; yaw += Math.sin(time * 1.7) * 0.05; }
    if (yawnT >= 0) {
      const k = Math.sin(clamp(yawnT / 2.4, 0, 1) * Math.PI);
      pitch += k * 0.45; mouth = Math.max(mouth, smooth(k * 1.6) * 0.95);
    }
    if (dizzyAmt > 0.01) {
      yaw += Math.sin(time * 6.5) * 0.3 * dizzyAmt;
      tilt += Math.cos(time * 6.5) * 0.25 * dizzyAmt;
    }
    if (rx && rx.kind === 'tickle') mouth = Math.max(mouth, 0.55 + 0.35 * Math.sin(rx.t * 22));
    if (rx && rx.kind === 'horn') pitch += Math.sin(clamp(rx.t / 1.2, 0, 1) * Math.PI) * 0.35;
    if (rx && rx.kind === 'pet') mouth = Math.max(mouth, 0.35 * Math.sin(clamp(rx.t / 1.2, 0, 1) * Math.PI));
    if (rx && rx.kind === 'eat' && food.t > 0.6 && food.t < 1.7) mouth = Math.max(mouth, 0.25 + 0.25 * Math.sin(food.t * 18));
    if (rx && rx.kind === 'wake') mouth = Math.max(mouth, 0.5 * Math.sin(clamp(rx.t / 0.8, 0, 1) * Math.PI));

    // apply: head-local +Z is up (turn), X is nod, Y is tilt (roll)
    const nk = neck.filter(Boolean);
    nk.forEach((b) => { rotLocal(b, AZ, -yaw * 0.12); rotLocal(b, AX, -pitch * 0.12); });
    rotLocal(head, AZ, -yaw * (1 - 0.12 * nk.length));
    rotLocal(head, AX, -pitch * (1 - 0.12 * nk.length));
    rotLocal(head, AY, tilt);

    // ears: perk forward when listening, droop when sleeping, random twitch
    nextTwitchT -= dt;
    let twitchL = 0, twitchR = 0;
    if (nextTwitchT < 0) { if (nextTwitchT < -0.18) nextTwitchT = rnd(2, 5); twitchL = Math.random() < 0.5 ? Math.sin(-nextTwitchT * 35) * 0.3 : 0; twitchR = twitchL ? 0 : Math.sin(-nextTwitchT * 35) * 0.3; }
    const earTalk = base === 'talking' ? mouthSm * 0.25 : 0;
    ['L', 'R'].forEach((side, si) => {
      const b = ears[side][0];
      if (!b) return;
      const s = si ? -1 : 1;
      rotLocal(b, AX, earPerk * 0.35 + earTalk + (si ? twitchR : twitchL));
      rotLocal(b, AZ, s * earPerk * 0.15);
    });
    // tail swish
    const swish = (rx && (rx.kind === 'pet' || rx.kind === 'tickle' || rx.kind === 'eat')) ? 0.35 : sleeping ? 0.03 : 0.12;
    tail.forEach((b, i) => { if (b && i > 0) rotLocal(b, AZ, Math.sin(time * (rx ? 9 : 2.2) - i * 0.6) * swish / tail.length * 2); });

    // mouth + eyes (look.update re-applies the chibi scales, smooths the mouth and runs auto-blink)
    look.setMouth(mouth);
    eyeTarget = sleeping ? 1
      : rx && (rx.kind === 'pet' || rx.kind === 'tickle') && rx.t < 1.2 ? 0.8
      : rx && rx.kind === 'eat' && food.t > 0.65 && food.t < 1.8 ? 0.75
      : dizzyAmt > 0.3 ? 0.45
      : yawnT >= 0 ? 0.7 * Math.sin(clamp(yawnT / 2.4, 0, 1) * Math.PI)
      : 0;
    eyeK = damp(eyeK, eyeTarget, sleeping ? 2.2 : 12, dt);
    if (eyeK > 0.02) { look.setEyesClosed(eyeK); eyesWereClosed = true; }
    else if (eyesWereClosed) { look.setEyesClosed(0); eyesWereClosed = false; }
    look.update(dt);

    // ---- body: breathing scale, squash spring, hops
    sqV += (-140 * sq - 9 * sqV) * dt; sq += sqV * dt;
    hopV -= 9.8 * dt; hop += hopV * dt; if (hop < 0) { hop = 0; hopV = 0; }
    const br = Math.sin(time * (sleeping ? 1.6 : 2.4)) * (sleeping ? 0.02 : 0.01);
    const sy = 1 + sq + br, sxz = 1 - sq * 0.5 - br * 0.4;
    pivot.scale.set(sxz, sy, sxz);
    pivot.position.y = hop * 0.35;
    pivot.rotation.z = rx && rx.kind === 'tickle' ? Math.sin(rx.t * 26) * 0.035 * (1 - rx.t / rx.dur) : damp(pivot.rotation.z, 0, 8, dt);
    blob.scale.set(1.9 * (1 - hop * 0.3), 1.25 * (1 - hop * 0.3), 1);
    blob.material.opacity = 1 - hop * 0.5;

    model.updateMatrixWorld(true);

    // ---- horn glow, dizzy stars, Zzz, motes
    const tip = hornTip(new V3());
    hornGlow.position.copy(tip);
    const hornBoost = rx && rx.kind === 'horn' ? Math.max(0, 1 - rx.t / 1.6) : 0;
    hornGlow.scale.setScalar(0.2 + Math.sin(time * 2.2) * 0.03 + hornBoost * 0.6);
    hornGlow.material.opacity = (sleeping ? 0.15 : 0.3) + hornBoost * 0.55;
    if (hornBoost > 0) { tmpC.setHSL((time * 1.5) % 1, 0.9, 0.7); hornMat.emissive.copy(tmpC); hornMat.emissiveIntensity = 0.22 + hornBoost * 1.1; hornGlow.material.color.copy(tmpC); }
    else { hornMat.emissive.copy(hornEmissive); hornMat.emissiveIntensity = 0.22 + Math.sin(time * 2.2) * 0.05; hornGlow.material.color.set('#ffd9f4'); }

    const hp = headWorld(new V3());
    dizzyStars.forEach((s, i) => {
      s.visible = dizzyAmt > 0.02;
      if (!s.visible) return;
      const a = time * 4 + (i / dizzyStars.length) * 6.28;
      s.position.set(hp.x + Math.cos(a) * 0.3, hp.y + 0.3 + Math.sin(a * 2) * 0.02 + Math.sin(a) * 0.06, hp.z + Math.sin(a) * 0.3);
      s.scale.setScalar(0.12 * dizzyAmt);
      s.material.opacity = dizzyAmt;
      s.material.rotation = Math.sin(time * 5 + i) * 0.4;
    });

    if (sleeping && stateT > 1.6) {
      zzzT -= dt;
      if (zzzT <= 0) {
        zzzT = 1.3;
        camBasis();
        spawn({ tex: 'zzz', pos: hp.clone().add(new V3(0, 0.2, 0)).addScaledVector(camRight, 0.12), vel: camUp.clone().multiplyScalar(0.28).addScaledVector(camRight, 0.12), life: 2.6, size0: 0.08, size1: 0.3, wob: 0.15, front: true, fadeIn: 0.4 });
      }
    }

    for (const m of motes) {
      m.a += m.sp * dt;
      const y = m.h + Math.sin(time * 0.6 + m.ph) * 0.25;
      m.s.position.set(Math.cos(m.a) * m.r, y, Math.sin(m.a) * m.r * 0.7 + 0.2);
      const tw = 0.55 + 0.45 * Math.sin(time * 3 + m.ph * 3);
      m.s.scale.setScalar(m.sz * (0.7 + tw * 0.6));
      m.mat.opacity = (sleeping ? 0.35 : 0.8) * tw;
    }
    updatePool(poolAdd, dt);
    updatePool(poolEmo, dt);

    // ---- camera: gentle orbit sway, closer while listening/talking, shake on bonk
    camPull = damp(camPull, base === 'listening' || base === 'talking' ? 1 : sleeping ? 0.4 : 0, 1.5, dt);
    camShake = Math.max(0, camShake - dt * 0.35);
    const d = frame.dist * (1 - 0.1 * camPull);
    const yawC = Math.sin(time * 0.21) * 0.07 + Math.sin(time * 0.13) * 0.03;
    const el = frame.elev + Math.sin(time * 0.17) * 0.025 + camPull * 0.02;
    const tgt = tmpV.copy(frame.target); tgt.y += camPull * 0.1 - (sleeping ? 0.25 * camPull : 0); tgt.x -= camPull * 0.05;
    camera.position.set(tgt.x + Math.sin(yawC) * d * Math.cos(el), tgt.y + Math.sin(el) * d, tgt.z + Math.cos(yawC) * d * Math.cos(el));
    if (camShake > 0) camera.position.add(tmpV2.set(rnd(-1, 1), rnd(-1, 1), 0).multiplyScalar(camShake * 0.25));
    camera.lookAt(tgt);
  }

  // ------------------------------------------------------------------ loop (with adaptive resolution)
  let raf = 0, last = performance.now(), alive = true, frameAvg = 1 / 60, slowFor = 0, fastFor = 0;
  const minPR = 1;
  function loop(now) {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    const rawDt = (now - last) / 1000; last = now;
    const dt = Math.min(0.05, Math.max(0, rawDt));
    frameAvg = lerp(frameAvg, rawDt, 0.05);
    if (!document.hidden && rawDt < 0.5) {
      if (frameAvg > 1 / 45) slowFor += rawDt; else slowFor = 0;
      if (frameAvg < 1 / 58) fastFor += rawDt; else fastFor = 0;
      if (slowFor > 2 && pixelRatio > minPR) { pixelRatio = Math.max(minPR, pixelRatio - 0.25); renderer.setPixelRatio(pixelRatio); resize(); slowFor = 0; }
      else if (fastFor > 6 && pixelRatio < Math.min(window.devicePixelRatio || 1, maxPR) - 0.01) { pixelRatio = Math.min(maxPR, pixelRatio + 0.25); renderer.setPixelRatio(pixelRatio); resize(); fastFor = 0; }
    }
    update(dt);
    renderer.render(scene, camera);
  }

  resize();
  baseClip(0);
  update(0.016);
  renderer.compile(scene, camera);
  renderer.render(scene, camera);
  raf = requestAnimationFrame(loop);

  const api = {
    setState,
    react,
    setMouth(v) { mouthLevel = clamp(+v || 0, 0, 1); },
    onHit(cb) { if (typeof cb === 'function') hitCbs.push(cb); },
    resize,
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      mixer.stopAllAction();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
      Object.values(TEX).forEach((t) => t && t.dispose());
      disposables.forEach((d) => d && d.dispose && d.dispose());
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch {}
      canvas.remove();
      hitCbs.length = 0;
    },
  };
  if (opts.debug) {
    api.__debug = {
      THREE, renderer, scene, camera, look, mixer, actions, hitTest, yawn() { yawnT = 0; },
      get state() { return { base, react: rx && rx.kind, clip: curName, pixelRatio, fps: Math.round(1 / frameAvg), calls: renderer.info.render.calls, tris: renderer.info.render.triangles }; },
      step(sec, n = 30) { for (let i = 0; i < n; i++) update(sec / n); renderer.render(scene, camera); },
      partAt(part) {   // screen position of a part (for tests)
        model.updateMatrixWorld(true);
        const p = part === 'horn' ? look.horn.localToWorld(new V3(0, UNICORN.look.horn.length * 0.6, 0)) : part === 'belly' ? bellyWorld(new V3()) : part === 'head' ? headWorld(new V3()) : model.localToWorld(new V3(0, 2.8, -1.2));
        p.project(camera);
        const r = canvas.getBoundingClientRect();
        return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
      },
    };
  }
  return api;
}

export default createScene;
