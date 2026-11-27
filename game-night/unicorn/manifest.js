// ניצנוץ – asset manifest. Every path is relative to game-night/ (the page's folder).
// Licences and sources: unicorn/CREDITS.txt.
const B = 'unicorn/';

export const UNICORN = {
  // Skinned, animated model: Quaternius "Ultimate Animated Animals" Horse (CC0), recoloured pastel and slimmed
  // (constant animation channels removed, so bone .scale is free to change; no scale tracks remain).
  model: B + 'models/unicorn.glb',
  // Native size: ~4.8 units tall (ears), ~5.7 long, 1.4 wide. Faces +Z, up +Y, hooves at y = 0.
  scaleTo1: 1 / 4.8,          // multiply to make it 1 unit tall; 0.33 gives ~1.6 m which suits the meadow scales below
  facing: '+Z',
  frontYaw: -0.5,             // a 3/4 view toward a camera on +Z reads best (rotation.y in radians)
  // Camera hint for a portrait phone (fov 40, unicorn scaled 0.33 at origin): pos (0, 1.3, 5.2) look at (0, 1.0, 0).
  // Head close-up (with frontYaw): pos (0.15, 1.6, 2.7) look at (-0.35, 1.35, 0.7).
  camera: { portrait: { pos: [0, 1.3, 5.2], look: [0, 1.0, 0] }, close: { pos: [0.15, 1.6, 2.7], look: [-0.35, 1.35, 0.7] } },

  // Animation clips in the GLB (name: seconds). All are loopable except where noted.
  clips: {
    Idle: 3.33, Idle_2: 3.33, Idle_Headlow: 3.33,           // idle variations (Idle_Headlow = sniffing the grass)
    Eating: 6.0,                                            // head down, chewing grass – use for "eat"
    Walk: 1.17, Gallop: 0.6,                                // locomotion (in place; root does not move)
    Gallop_Jump: 1.47, Jump_toIdle: 1.73,                   // one-shots: happy jump
    Attack_Headbutt: 1.03, Attack_Kick: 1.0,                // one-shots: playful headbutt / buck kick
    Idle_HitReact_Left: 0.67, Idle_HitReact_Right: 0.67,    // one-shots: flinch – use for "bonk"
    Death: 1.0,                                             // one-shot, clamp: lies down – use (slowed) for "sleep"/"dizzy" collapse
  },
  // Suggested mapping from scene states / reactions to clips
  stateClips: {
    idle: ['Idle', 'Idle_2', 'Idle_Headlow'],
    listening: 'Idle',           // plus ear/head tilt done procedurally on the bones below
    talking: 'Idle_2',           // plus mouth + head bob from the voice level
    sleeping: 'Death',           // play at timeScale 0.35, clampWhenFinished; eyes closed
    happy: 'Gallop_Jump',
    dizzy: 'Idle_HitReact_Left',
    eating: 'Eating',
  },
  reactClips: { pet: 'Jump_toIdle', tickle: 'Attack_Kick', horn: 'Attack_Headbutt', bonk: 'Idle_HitReact_Right', eat: 'Eating', wake: 'Jump_toIdle' },

  // Bone names AS THREE.JS SEES THEM (GLTFLoader strips the dots: "Ear1.L" -> "Ear1L").
  // There is no jaw bone: the mouth is a separate mesh added by unicorn-look.js (setMouth), plus a head bob.
  bones: {
    root: 'Body', spine: ['Back', 'Torso', 'Torso2', 'Torso3'],
    neck: ['Neck1', 'Neck2', 'Neck3'], head: 'Head', jaw: null,
    earL: ['Ear1L', 'Ear2L', 'Ear3L', 'Ear4L'], earR: ['Ear1R', 'Ear2R', 'Ear3R', 'Ear4R'],
    tail: ['Tail1', 'Tail2', 'Tail3', 'Tail4', 'Tail5', 'Tail6', 'Tail7'],
    legs: { frontL: ['FrontShoulderL', 'FrontUpperLegL', 'FrontLowerLegL'], frontR: ['FrontShoulderR', 'FrontUpperLegR', 'FrontLowerLegR'],
            backL: ['BackShoulderL', 'BackLegL', 'BackUpperLegL', 'BackLowerLegL'], backR: ['BackShoulderR', 'BackLegR', 'BackUpperLegR', 'BackLowerLegR'] },
  },
  // Head bone local frame (model units, before scaling): +Z points up out of the forehead, +Y toward the snout,
  // +X toward the unicorn's right side (world -X). To nod "yes" rotate Head about local X; tilt = local Y; turn = local Z.
  headLocal: {
    eyes: [[-0.245, 0.34, 0.208], [0.245, 0.34, 0.208]],
    mouth: [0, 1.02, -0.11],
    snoutTip: [0, 1.11, -0.05],
    forehead: [0, 0.28, 0.3],
    // tap zones (sphere centre in head-local coords, radius) – the horn is the Horn mesh itself
    hitHead: { center: [0, 0.55, 0.05], radius: 0.6 },
  },
  // Belly hit zone in model space (unscaled): sphere under the torso
  hitBelly: { center: [0, 2.3, 0.4], radius: 0.9 },

  colors: {
    Main: '#fff3fb', Main_Light: '#e8dcff', Hooves: '#ffd36e', Hair: '#ffb3e6', Muzzle: '#ffc2dc',
    Eye_White: '#ffffff', Eye_Black: '#2a1840',
    eye: '#2a1840', horn: '#ffcf6b', hornGlow: '#ffc8ee', mouth: '#b2386e', tongue: '#ff8fb8',
    rainbow: ['#ff9ad5', '#ffc48a', '#fff08a', '#a8f0a0', '#8fd8ff', '#c9a8ff'],
    sky: '#cfe6fb', fog: '#d6e8f7', grass: '#9ad77d', grassDark: '#6fbf5a',
    ui: { pink: '#ff7ac8', lilac: '#b98cff', mint: '#7fe0c4', cream: '#fff6e8' },
  },
  // Defaults used by applyUnicornLook (unicorn-look.js); any of them can be overridden there.
  look: {
    headScale: 1.5, neckScale: 0.85, overlayEyes: true, rainbowMane: true, maneSaturation: 0.7, maneBands: 0.9, maneHueShift: 0.73,
    horn: { length: 0.75, radius: 0.1, twists: 3, pos: [0, 0.28, 0.3], dir: [0, 0.15, 1] },
    eyes: { radius: 0.085, flatten: 0.55 },
    mouth: { width: 0.1, depth: 0.07, height: 0.12 },
  },
};

// Meadow: Quaternius "Stylized Nature MegaKit" (CC0). One GLB; each top-level node is one plant.
// gltf.scene.getObjectByName(name).clone(). [suggested scale, native height]
export const NATURE = {
  file: B + 'models/nature.glb',
  items: {
    Flower_3_Group: [0.2, 2.06], Flower_4_Group: [0.18, 2.49], Grass_Common_Short: [0.25, 1.33], Grass_Common_Tall: [0.22, 1.87],
    Clover_1: [0.25, 1.15], Fern_1: [0.05, 2.69], Bush_Common: [0.4, 1.58], Bush_Common_Flowers: [0.35, 1.58], CommonTree_3: [0.55, 9.43],
  },
  // A good recipe: ~250 small plants at radius 1.4–13 around the unicorn (leave the camera side clear),
  // 6–8 trees/bushes in a ring at radius ~14 behind it, ground = CircleGeometry(60) colour colors.grass, Fog(fog, 18, 45).
  // Alpha-cut leaves: set material.alphaTest = 0.5 and side = DoubleSide if they look holey from behind.
};

// Props: Kenney Food Kit + Platformer Kit (CC0). One GLB; top-level node names below. Sizes are native (≈ metres).
export const PROPS = {
  file: B + 'models/props.glb',
  food: ['cupcake', 'donut-sprinkles', 'lollypop', 'strawberry', 'cookie', 'candy-bar', 'apple', 'carrot'],
  other: ['heart', 'star', 'jewel', 'coin-gold'],
  // native height of each; 0.8–1.2x looks right next to the unicorn scaled 0.33
  heights: { cupcake: 0.42, 'donut-sprinkles': 0.1, lollypop: 0.38, strawberry: 0.18, cookie: 0.05, 'candy-bar': 0.07,
             apple: 0.19, carrot: 0.72, heart: 0.38, star: 0.36, jewel: 0.37, 'coin-gold': 0.4 },
};

// 360° sky: Poly Haven "Kloofendal 48d Partly Cloudy (Pure Sky)" (CC0), tonemapped, 2048x1024.
// Lower half is a soft haze so a ground plane can cut it anywhere. Use EquirectangularReflectionMapping, SRGBColorSpace.
export const BACKGROUND = { sky: B + 'bg/sky.jpg', mapping: 'equirect' };

// 2D sprites (Microsoft Fluent Emoji 3D, MIT) – 128 px WebP (unicorn 192 px), for particles, HUD and buttons.
export const SPRITES = Object.fromEntries(
  ['cupcake', 'candy', 'lollipop', 'dizzy', 'glowing_star', 'star', 'growing_heart', 'pink_heart', 'sparkling_heart',
   'sparkles', 'rainbow', 'zzz', 'musical_notes', 'cloud', 'collision', 'microphone', 'unicorn']
    .map((n) => [n, `${B}sprites/${n}.webp`]));

// Particle textures (Kenney Particle Pack, CC0) – 128 px white-on-alpha PNG (LA); tint with material.color,
// use AdditiveBlending for glows. star_* = twinkles, magic_* = rune rings for the horn burst,
// circle_05/light_01 = soft dots, twirl_02 = swirl, flare_01 = lens flare.
export const FX = Object.fromEntries(
  ['circle_05', 'light_01', 'magic_02', 'magic_05', 'star_04', 'star_06', 'star_07', 'star_08', 'twirl_02', 'flare_01']
    .map((n) => [n, `${B}fx/${n}.png`]));

// Sound effects (freesound.org, all CC0) – mono MP3, trimmed, peak-normalised to -1 dBFS.
export const SFX = Object.fromEntries(
  ['giggle', 'giggle2', 'pop', 'pop2', 'sparkle', 'sparkle2', 'magic', 'magic2', 'munch', 'bonk', 'boing', 'dizzy',
   'snore', 'sleep', 'yawn', 'neigh', 'nicker', 'kiss']
    .map((n) => [n, `${B}sfx/${n}.mp3`]));
// What each is for
export const SFX_USE = {
  pet: ['nicker', 'kiss', 'sparkle'], tickle: ['giggle', 'giggle2'], horn: ['magic', 'sparkle2', 'magic2'],
  bonk: ['bonk', 'boing', 'dizzy'], eat: ['pop', 'munch'], sleep: ['yawn', 'snore'], wake: ['neigh', 'pop2'],
  ui: ['pop', 'pop2'],
};

// Background music (freesound.org, CC0). Loop with Web Audio (decode, then source.loop = true; MP3 adds ~50 ms of
// padding, so set loopStart = 0.05 and loopEnd = duration - 0.05), at a low volume (~0.25).
export const MUSIC = { loop: B + 'music/loop.mp3', alt: B + 'music/loop2.mp3' };

export default { UNICORN, NATURE, PROPS, BACKGROUND, SPRITES, FX, SFX, SFX_USE, MUSIC };
