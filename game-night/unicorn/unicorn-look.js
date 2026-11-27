// ניצנוץ – turns the CC0 Quaternius horse (unicorn/models/unicorn.glb) into our cute unicorn:
// pastel materials, a rainbow mane and tail, a twisted pearly horn, big glossy eyes that can blink,
// a small mouth that opens with the voice level, and chibi head proportions.
// Usage (after GLTFLoader):  const look = applyUnicornLook(gltf.scene, THREE);
//   per frame, AFTER mixer.update():  look.update(dt)   (re-applies bone scales, blink)
//   look.setMouth(0..1)   look.blink()   look.horn / look.head / look.eyes / look.ears
// THREE is passed in so this file has no import of its own.
import { UNICORN } from './manifest.js';

export function applyUnicornLook(root, THREE, opts = {}) {
  const o = { ...UNICORN.look, ...opts };
  const C = UNICORN.colors;
  const bone = (n) => root.getObjectByName(n);
  const head = bone(UNICORN.bones.head);

  // ---------- materials ----------
  const meshes = [];
  root.traverse((m) => {
    if (!m.isMesh) return;
    m.castShadow = true; m.frustumCulled = false; meshes.push(m);
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    mats.forEach((mat) => {
      const key = mat.name;
      if (C[key]) mat.color.set(C[key]);
      mat.metalness = 0; mat.roughness = key === 'Eye_Black' ? 0.15 : 0.55;
      // the overlay eyes replace the model's tiny ones: paint the originals in skin colour
      if (o.overlayEyes && (key === 'Eye_Black' || key === 'Eye_White')) mat.color.set(C.Main);
      if (key === 'Hair' && o.rainbowMane) {
        mat.color.set('#ffffff');
        const sat = o.maneSaturation.toFixed(3), freq = o.maneBands.toFixed(3), shift = o.maneHueShift.toFixed(3);
        mat.onBeforeCompile = (sh) => {
          sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vRest;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position;');
          sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', `#include <common>
varying vec3 vRest;
vec3 uniRainbow(float h){ vec3 k = clamp(abs(mod(h*6.0+vec3(0.,4.,2.),6.0)-3.0)-1.0,0.,1.); return mix(vec3(1.), k, ${sat}); }`)
            .replace('vec4 diffuseColor = vec4( diffuse, opacity );',
              `vec4 diffuseColor = vec4( diffuse * uniRainbow(fract((vRest.y + vRest.z) * 0.35 * ${freq} + ${shift})), opacity );`);
        };
        mat.customProgramCacheKey = () => 'uniRainbowMane' + sat + freq + shift;
      }
    });
  });

  // ---------- horn (Head-local: +Z = up out of the forehead, +Y = toward the snout) ----------
  const H = o.horn;
  const geo = new THREE.ConeGeometry(H.radius, H.length, 14, 28, false);
  const p = geo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const t = v.y / H.length + 0.5, rr = Math.hypot(v.x, v.z), ang = Math.atan2(v.z, v.x);
    const bump = 1 + 0.18 * Math.sin(ang * 3 - t * Math.PI * H.twists * 2);
    p.setXYZ(i, Math.cos(ang) * rr * bump, v.y, Math.sin(ang) * rr * bump);
  }
  geo.computeVertexNormals(); geo.translate(0, H.length / 2, 0);
  const horn = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: C.horn, emissive: C.hornGlow, emissiveIntensity: 0.22, roughness: 0.2, metalness: 0.45 }));
  horn.name = 'Horn'; horn.castShadow = true;
  horn.position.fromArray(H.pos);
  horn.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...H.dir).normalize());
  head.add(horn);

  // ---------- big glossy eyes ----------
  const eyes = [];
  if (o.overlayEyes) {
    const E = o.eyes;
    const irisMat = new THREE.MeshStandardMaterial({ color: C.eye, roughness: 0.12, metalness: 0 });
    const shineMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    UNICORN.headLocal.eyes.forEach((pos, i) => {
      const side = pos[0] > 0 ? 1 : -1;
      const g = new THREE.Group(); g.name = side > 0 ? 'EyeL' : 'EyeR';
      g.position.fromArray(pos);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(E.radius, 24, 16), irisMat);
      const s1 = new THREE.Mesh(new THREE.SphereGeometry(E.radius * 0.3, 12, 8), shineMat);
      s1.position.set(side * E.radius * 0.78, E.radius * 0.38, E.radius * 0.42);
      const s2 = new THREE.Mesh(new THREE.SphereGeometry(E.radius * 0.14, 8, 6), shineMat);
      s2.position.set(side * E.radius * 0.8, -E.radius * 0.1, -E.radius * 0.35);
      ball.name = 'Ball'; s1.name = 'Shine'; s2.name = 'Shine2';
      g.add(ball, s1, s2);
      g.scale.set(E.flatten, 1, 1);
      head.add(g); eyes.push(g);
    });
  }

  // ---------- mouth (opens with the voice level) ----------
  const M = o.mouth;
  const mouth = new THREE.Group(); mouth.name = 'Mouth';
  mouth.position.fromArray(UNICORN.headLocal.mouth);
  const inner = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshStandardMaterial({ color: C.mouth, roughness: 0.6 }));
  const tongue = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), new THREE.MeshStandardMaterial({ color: C.tongue, roughness: 0.5 }));
  tongue.position.set(0, -0.2, -0.45);
  inner.add(tongue);
  inner.scale.set(M.width, M.depth, 0.001);
  mouth.add(inner); mouth.visible = false; head.add(mouth);

  // ---------- proportions ----------
  const scales = [[UNICORN.bones.head, o.headScale], [UNICORN.bones.neck[0], o.neckScale]];
  const applyScales = () => scales.forEach(([n, s]) => { const b = bone(n); if (b) b.scale.setScalar(s); });
  applyScales();

  // 0 = open, 1 = shut: the eyeball squashes into a dark line and the shines hide
  const closeEyes = (k) => eyes.forEach((e) => {
    e.getObjectByName('Ball').scale.z = 1 - 0.85 * k;   // head-local Z is up
    e.getObjectByName('Shine').visible = e.getObjectByName('Shine2').visible = k < 0.5;
  });
  let mouthOpen = 0, mouthTarget = 0, blinkT = -1, nextBlink = 2 + Math.random() * 3;
  const api = {
    head, horn, eyes, mouth, meshes,
    neck: UNICORN.bones.neck.map(bone),
    ears: { L: UNICORN.bones.earL.map(bone), R: UNICORN.bones.earR.map(bone) },
    tail: UNICORN.bones.tail.map(bone),
    setMouth(x) { mouthTarget = Math.max(0, Math.min(1, x)); },
    blink() { blinkT = 0; },
    autoBlink: true,
    update(dt = 1 / 60) {
      applyScales();
      mouthOpen += (mouthTarget - mouthOpen) * Math.min(1, dt * 25);
      inner.scale.z = 0.001 + M.height * mouthOpen;
      mouth.visible = mouthOpen > 0.03;
      if (api.autoBlink && (nextBlink -= dt) <= 0) { blinkT = 0; nextBlink = 2.5 + Math.random() * 4; }
      if (blinkT >= 0) {
        blinkT += dt; const k = blinkT < 0.07 ? blinkT / 0.07 : blinkT < 0.16 ? 1 - (blinkT - 0.07) / 0.09 : 0;
        closeEyes(k);
        if (blinkT > 0.16) blinkT = -1;
      }
    },
    // close or open the eyes for sleeping (0 = open, 1 = shut); turns off autoBlink while shut
    setEyesClosed(k) {
      api.autoBlink = k < 0.5; blinkT = -1;
      closeEyes(k);
    },
  };
  return api;
}
