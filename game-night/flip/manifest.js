// "עולם הפוך" (Flip) — asset manifest [ASSETS]
// All art & sound: Kenney (www.kenney.nl, CC0) + 4 CC0 music loops from OpenGameArt. See CREDITS.txt.
// Every path below is relative to BASE and exists (checked by a node script during the build).
//
// Conventions
// - World scale: 1 tile = 64 px. World/item frames are 64x64 (door 64x128), drawn 1:1.
// - Characters: 128x128 frames, feet on the bottom edge of the frame (use origin (0.5,1) or the body box below).
// - Enemies: 64x64 frames, bottom-aligned (walkers stand on the bottom edge).
// - Spikes/spring/etc. are drawn "pointing up" (floor = bottom of the 64 tile). Rotate for other directions:
//   '^' 0, '>' 90, 'v' 180, '<' -90 degrees around the tile centre.
// - FX textures are white/grey on transparent: tint them in Phaser (particles tint / setTint).
// - Atlases are Phaser "JSON hash" (scene.load.atlas). Frames are untrimmed and edge-extruded by 2 px (no seams).

export const BASE = 'flip/';
export const TILE = 64;

export const ATLASES = {
  world: { png: 'atlas/world.png', json: 'atlas/world.json', size: [1024, 1016] }, // terrain (6 sets) + items + decor
  chars: { png: 'atlas/chars.png', json: 'atlas/chars.json', size: [1024, 1196] }, // 5 player skins (128) + all Kenney enemies (64)
  fx:    { png: 'atlas/fx.png',    json: 'atlas/fx.json',    size: [512, 468] },   // Kenney Particle Pack, white
};

// ---------- terrain (autotile) ----------
// Each set has: single block, 3x3 nine-slice for masses, 1-tall horizontal strip, 1-wide vertical strip,
// and "cloud" floating-platform pieces (nice for moving platforms: cloud_left/middle/right, or cloud for 1 tile).
const terrain = (t) => ({
  atlas: 'world',
  single: `${t}_block`,
  top_left: `${t}_block_top_left`, top: `${t}_block_top`, top_right: `${t}_block_top_right`,
  left: `${t}_block_left`, center: `${t}_block_center`, right: `${t}_block_right`,
  bottom_left: `${t}_block_bottom_left`, bottom: `${t}_block_bottom`, bottom_right: `${t}_block_bottom_right`,
  h_left: `${t}_horizontal_left`, h_mid: `${t}_horizontal_middle`, h_right: `${t}_horizontal_right`,
  v_top: `${t}_vertical_top`, v_mid: `${t}_vertical_middle`, v_bottom: `${t}_vertical_bottom`,
  cloud: `${t}_cloud`, cloud_left: `${t}_cloud_left`, cloud_mid: `${t}_cloud_middle`, cloud_right: `${t}_cloud_right`,
});
export const TERRAINS = {
  grass: terrain('grass'), stone: terrain('stone'), snow: terrain('snow'),
  sand: terrain('sand'), purple: terrain('purple'), dirt: terrain('dirt'),
};

/** Pick the right terrain frame for a solid cell. u,d,l,r = is the neighbour in that direction solid ground?
 *  (Treat out-of-map as solid so the border blends.) Returns a frame name in atlas 'world'. */
export function terrainFrame(tiles, u, d, l, r) {
  if (!u && !d) return !l && !r ? tiles.single : !l ? tiles.h_left : !r ? tiles.h_right : tiles.h_mid;
  if (!l && !r) return !u ? tiles.v_top : !d ? tiles.v_bottom : tiles.v_mid;
  const row = !u ? 'top' : !d ? 'bottom' : '';
  const col = !l ? 'left' : !r ? 'right' : '';
  return tiles[[row, col].filter(Boolean).join('_') || 'center'];
}

// ---------- themes (one per world) ----------
// bg: layers far -> near. Suggested use: sky = fixed TileSprite filling the screen (anchor its BOTTOM to the
// horizon/bottom of screen; it fades from #c3e3ff at the top to white at the bottom); clouds/far/near = TileSprites
// anchored to the screen bottom, scrollFactor per bgInfo. Fill below 'near' with `ground` colour if the view is taller.
// Layer images are 512 wide and tile seamlessly horizontally.
const SKY = 'bg/sky.jpg';        // 512x1280 opaque: solid sky (512) + cloud band (512) + white (256)
const CLOUDS = 'bg/clouds.png';  // 512x292 white cloud bank (solid white at its bottom: sit it on the sky's white horizon), drift it slowly
export const THEMES = {
  grass: {
    name: 'יער', tiles: TERRAINS.grass,
    bg: [SKY, CLOUDS, 'bg/trees_far.png', 'bg/trees_near.png'],
    bgInfo: { scroll: [0, 0.05, 0.15, 0.3], heights: [1280, 292, 353, 353], bottomOffset: [0, 200, 110, 0] },
    ground: '#2ecc71', skyTop: '#c3e3ff', accent: '#2ecc71',
    music: 'audio/music_grass.mp3',
    gem: 'gem_blue', key: 'key_yellow', lock: 'lock_yellow',
    decor: ['bush', 'grass', 'mushroom_red', 'mushroom_brown', 'rock', 'fence', 'sign_right'],
    platform: ['grass_cloud_left', 'grass_cloud_middle', 'grass_cloud_right'],
    thumb: 'ui/world_grass.jpg',
  },
  stone: {
    name: 'מערות', tiles: TERRAINS.stone,
    bg: [SKY, CLOUDS, 'bg/mushrooms_far.png', 'bg/mushrooms_near.png'],
    bgInfo: { scroll: [0, 0.05, 0.15, 0.3], heights: [1280, 292, 354, 361], bottomOffset: [0, 200, 110, 0] },
    // cave mood: tint the background layers e.g. 0xb8a8c8 (or a dark overlay at 25%); tiles stay untinted
    bgTint: 0xc0b0d0,
    ground: '#de7e4f', skyTop: '#c3e3ff', accent: '#de7e4f',
    music: 'audio/music_stone.mp3',
    gem: 'gem_red', key: 'key_yellow', lock: 'lock_yellow',
    decor: ['torch_on_a', 'mushroom_brown', 'rock', 'chain', 'cactus', 'fence_broken'],
    platform: ['stone_cloud_left', 'stone_cloud_middle', 'stone_cloud_right'],
    thumb: 'ui/world_stone.jpg',
    altTiles: TERRAINS.sand, altBg: ['bg/desert_far.png', 'bg/desert_near.png'], // optional sand variant
  },
  sky: {
    name: 'שמיים', tiles: TERRAINS.snow,
    bg: [SKY, CLOUDS, 'bg/hills_far.png', 'bg/hills_near.png'],
    bgInfo: { scroll: [0, 0.05, 0.15, 0.3], heights: [1280, 292, 284, 252], bottomOffset: [0, 180, 90, 0] },
    ground: '#2ecc71', skyTop: '#c3e3ff', accent: '#7fb8ff',
    music: 'audio/music_sky.mp3',
    gem: 'gem_yellow', key: 'key_blue', lock: 'lock_blue',
    decor: ['snow', 'rock', 'flag_green_a', 'grass_purple'],
    platform: ['snow_cloud_left', 'snow_cloud_middle', 'snow_cloud_right'],
    thumb: 'ui/world_sky.jpg',
    altTiles: TERRAINS.purple, // "candy" variant
  },
};
// Full single-image backdrops (512x512 opaque JPG) if a simpler background is wanted (menus, thumbnails):
export const BG_FULL = { grass: 'bg/trees_full.jpg', stone: 'bg/mushrooms_full.jpg', sky: 'bg/hills_full.jpg', sand: 'bg/desert_full.jpg' };

// ---------- sprites ----------
export const PLAYER_SKINS = ['green', 'beige', 'pink', 'purple', 'yellow'];
/** Player animation frames for a skin (atlas 'chars'). Kenney's walk cycle is 2 frames: add bob/squash in code. */
export function playerFrames(skin = 'green') {
  const f = (p) => `player_${skin}_${p}`;
  return {
    idle: [f('idle')], walk: [f('walk_a'), f('walk_b')], jump: [f('jump')], fall: [f('jump')],
    hurt: [f('hit')], land: [f('duck')], duck: [f('duck')], front: [f('front')], win: [f('front')],
    climb: [f('climb_a'), f('climb_b')],
  };
}

export const SPRITES = {
  player: {
    type: 'atlas', atlas: 'chars', frames: playerFrames('green'), fps: { walk: 9, climb: 8 },
    size: [128, 128],
    // visible character inside the 128 frame: x 22..106, y 31..128 (feet at y=128, facing RIGHT).
    // Suggested Arcade body (frame px, before any setScale): width 60, height 84, offset (34, 44).
    // Suggested display scale 0.72 (≈ 70 px tall vs 64 px tiles).
    body: { w: 60, h: 84, x: 34, y: 44 }, scale: 0.72, facing: 'right',
    skins: PLAYER_SKINS,
  },
  slime: { // walks on whatever floor gravity gives it; flat = squashed (stomped)
    type: 'atlas', atlas: 'chars', size: [64, 64], fps: 5,
    frames: { idle: ['slime_normal_rest'], walk: ['slime_normal_walk_a', 'slime_normal_walk_b'], dead: ['slime_normal_flat'] },
    body: { w: 52, h: 34, x: 6, y: 30 }, facing: 'left',
  },
  slimeSpike: { // variant that should NOT be stompable (spike on top)
    type: 'atlas', atlas: 'chars', size: [64, 64], fps: 5,
    frames: { idle: ['slime_spike_rest'], walk: ['slime_spike_walk_a', 'slime_spike_walk_b'], dead: ['slime_spike_flat'] },
    body: { w: 52, h: 36, x: 6, y: 28 }, facing: 'left',
  },
  slimeFire: {
    type: 'atlas', atlas: 'chars', size: [64, 64], fps: 6,
    frames: { idle: ['slime_fire_rest'], walk: ['slime_fire_walk_a', 'slime_fire_walk_b'], dead: ['slime_fire_flat'] }, facing: 'left',
  },
  fly: { // ignores gravity
    type: 'atlas', atlas: 'chars', size: [64, 64], fps: 14,
    frames: { fly: ['fly_a', 'fly_b'], dead: ['fly_rest'] }, body: { w: 44, h: 40, x: 10, y: 12 }, facing: 'left',
  },
  bee: { type: 'atlas', atlas: 'chars', size: [64, 64], fps: 14, frames: { fly: ['bee_a', 'bee_b'], dead: ['bee_rest'] }, facing: 'left' },
  ladybug: { type: 'atlas', atlas: 'chars', size: [64, 64], fps: 6, frames: { walk: ['ladybug_walk_a', 'ladybug_walk_b'], fly: ['ladybug_fly'], dead: ['ladybug_rest'] }, facing: 'left' },
  snail: { type: 'atlas', atlas: 'chars', size: [64, 64], fps: 4, frames: { walk: ['snail_walk_a', 'snail_walk_b'], shell: ['snail_shell'], dead: ['snail_rest'] }, facing: 'left' },
  saw: { // deadly blade: animated face frames + rotate the sprite in code (e.g. 720°/s). Circle radius ≈ 30.
    type: 'atlas', atlas: 'chars', size: [64, 64], fps: 12,
    frames: { spin: ['saw_a', 'saw_b'], idle: ['saw_rest'] }, radius: 30,
    plain: { atlas: 'world', frame: 'saw' }, // faceless metal saw (world atlas), also fine to spin
  },
  spikeBall: { atlas: 'world', frame: 'block_spikes' },
  gem: { atlas: 'world', frames: { blue: 'gem_blue', green: 'gem_green', red: 'gem_red', yellow: 'gem_yellow' }, size: [64, 64], box: [12, 14, 40, 35] },
  coin: { atlas: 'world', frames: { spin: ['coin_gold', 'coin_gold_side'] }, fps: 6, size: [64, 64], box: [13, 12, 38, 40],
          // smoother spin: tween scaleX 1 -> 0.1 -> 1 on 'coin_gold' instead of frame swap
          silver: ['coin_silver', 'coin_silver_side'], bronze: ['coin_bronze', 'coin_bronze_side'] },
  key: { atlas: 'world', frame: 'key_yellow', colors: { blue: 'key_blue', green: 'key_green', red: 'key_red', yellow: 'key_yellow' } },
  lock: { atlas: 'world', frame: 'lock_yellow', colors: { blue: 'lock_blue', green: 'lock_green', red: 'lock_red', yellow: 'lock_yellow' } },
  crate: { atlas: 'world', frame: 'block_planks', alt: 'block_plank' },
  spring: { atlas: 'world', idle: 'spring', bounce: 'spring_out', box: [0, 20, 64, 44] }, // bounce frame extends to full 64 height
  crumble: { atlas: 'world', idle: 'block_empty', warn: 'block_empty_warning', debris: ['brick_brown', 'brick_brown_diagonal'],
             stone: { idle: 'bricks_grey', debris: ['brick_grey', 'brick_grey_diagonal'] } },
  door: { atlas: 'world', closed: 'door_closed', open: 'door_open', size: [64, 128], sign: 'sign_exit' }, // place bottom on floor; 2 tiles tall
  spike: { atlas: 'world', frame: 'spikes', box: [4, 34, 56, 30] }, // points up; deadly box (x,y,w,h) inside the tile
  lockzone: { atlas: 'world', arrow: 'lockzone_arrow', tile: 'lockzone_tile' }, // white, tint per direction; arrow points UP
  checkpoint: { atlas: 'world', frames: { wave: ['flag_green_a', 'flag_green_b'], off: ['flag_off'] }, fps: 4, red: ['flag_red_a', 'flag_red_b'] },
  torch: { atlas: 'world', frames: { on: ['torch_on_a', 'torch_on_b'], off: ['torch_off'] }, fps: 6 },
  lever: { atlas: 'world', left: 'lever_left', right: 'lever_right' },
  switch: { atlas: 'world', up: 'switch_blue', down: 'switch_blue_pressed' },
  liquid: { atlas: 'world', water: ['water_top', 'water'], lava: ['lava_top', 'lava'] },
  heart: { atlas: 'world', frame: 'heart' },
  star: { atlas: 'world', frame: 'star' },
  bomb: { atlas: 'world', frames: ['bomb', 'bomb_active'] },
  blocks: { atlas: 'world', yellow: 'block_yellow', blue: 'block_blue', red: 'block_red', green: 'block_green',
            exclamation: ['block_exclamation', 'block_exclamation_active'], danger: ['block_strong_danger', 'block_strong_danger_active'] },
  hud: { atlas: 'world', coin: 'hud_coin', heart: 'hud_heart', heartEmpty: 'hud_heart_empty', key: 'hud_key_yellow', keyBlue: 'hud_key_blue' },
  decor: { atlas: 'world', frames: ['bush', 'grass', 'grass_purple', 'mushroom_brown', 'mushroom_red', 'rock', 'cactus', 'fence', 'fence_broken',
           'snow', 'chain', 'sign', 'sign_left', 'sign_right', 'sign_exit', 'ladder_middle', 'window', 'hill', 'hill_top'] },
};

// ---------- particles (atlas 'fx', white) ----------
export const FX = {
  atlas: 'fx',
  dust: 'smoke_01',    // 64 – landing/running dust (tint theme ground colour, alpha .6)
  smoke: 'smoke_04',   // 64 – death puff / crumble
  puff: 'smoke_07',    // 64 – soft puff
  spark: 'spark_01',   // 64 – gem collect sparks
  spark2: 'spark_04',  // 64
  star: 'star_04',     // 64 – 4-point star burst
  sparkle: 'star_01',  // 64 – tiny twinkle (gem idle shine)
  twinkle: 'star_06',  // 64
  starBig: 'star_07',  // 64
  ring: 'circle_05',   // 128 – shockwave ring (gravity flip, spring)
  soft: 'circle_01',   // 64 – soft dot
  glow: 'light_01',    // 128 – radial glow (behind gems / exit door)
  glowSmall: 'light_03', // 64
  flare: 'flare_01',   // 128 – lens flare streak (win)
  magic: 'magic_01',   // 128 – magic circle (gravity-lock zone / portal)
  magicSmall: 'magic_03', // 64
  twirl: 'twirl_01',   // 128 – swirl (gravity flip whoosh)
  twirl2: 'twirl_02',  // 128
  trace: 'trace_01',   // 64 – speed streak
  trace2: 'trace_04',  // 64
  dirt: 'dirt_01',     // 64 – debris chunks
  dirt2: 'dirt_02', dirt3: 'dirt_03',
};

// ---------- audio ----------
export const SFX = {
  jump: 'audio/jump.mp3', land: 'audio/land.mp3', gem: 'audio/gem.mp3', coin: 'audio/coin.mp3', key: 'audio/key.mp3',
  unlock: 'audio/unlock.mp3', spring: 'audio/spring.mp3', crumble: 'audio/crumble.mp3', death: 'audio/death.mp3',
  win: 'audio/win.mp3',          // 1.4 s rising jingle
  lose: 'audio/lose.mp3',        // 1.0 s falling jingle (optional, e.g. many deaths / quit)
  flip: 'audio/flip.mp3',        // whoosh on gravity change
  stomp: 'audio/stomp.mp3', click: 'audio/click.mp3',
  poof: 'audio/poof.mp3',        // enemy vanish / respawn
  push: 'audio/push.mp3',        // crate bump/land
  select: 'audio/select.mp3', back: 'audio/back.mp3', toggle: 'audio/toggle.mp3',
  star: 'audio/star.mp3',        // each star popping in on the win panel
  step: 'audio/step.mp3',        // quiet footstep
  door: 'audio/door.mp3', bump: 'audio/bump.mp3',
};
// Loops (stereo mp3, ~40-50 s, made to loop). Loudness roughly matched; play at volume ~0.45.
export const MUSIC = {
  grass: 'audio/music_grass.mp3', stone: 'audio/music_stone.mp3', sky: 'audio/music_sky.mp3', menu: 'audio/music_menu.mp3',
};

// ---------- UI (standalone PNG/JPG for DOM menus; 128 px art unless noted) ----------
export const UI = {
  star: 'ui/star.png', starEmpty: 'ui/star_empty.png', lockIcon: 'ui/lock.png', key: 'ui/key.png',
  gem: 'ui/gem_blue.png', gemBlue: 'ui/gem_blue.png', gemGreen: 'ui/gem_green.png', gemRed: 'ui/gem_red.png', gemYellow: 'ui/gem_yellow.png',
  coin: 'ui/coin.png', heart: 'ui/heart.png', heartEmpty: 'ui/heart_empty.png',
  door: 'ui/door.png',            // 128x256 open exit door
  flag: 'ui/flag.png', signExit: 'ui/sign_exit.png', spikes: 'ui/spikes.png', spring: 'ui/spring.png', crate: 'ui/crate.png', saw: 'ui/saw.png',
  arrow: 'ui/arrow.png',          // white chevron pointing UP (rotate for ◀▶▼, tilt buttons / how-to)
  playerHead: { green: 'ui/player_green.png', beige: 'ui/player_beige.png', pink: 'ui/player_pink.png', purple: 'ui/player_purple.png', yellow: 'ui/player_yellow.png' },
  char: { // 256x256 full-body character art
    idle: 'ui/char_green_idle.png', jump: 'ui/char_green_jump.png', walk: 'ui/char_green_walk_a.png', front: 'ui/char_green_front.png',
    green: 'ui/char_green_front.png', beige: 'ui/char_beige_front.png', pink: 'ui/char_pink_front.png', purple: 'ui/char_purple_front.png', yellow: 'ui/char_yellow_front.png',
  },
  enemy: { slime: 'ui/slime_normal_rest.png', slimeSpike: 'ui/slime_spike_rest.png', fly: 'ui/fly_a.png', saw: 'ui/saw_a.png', bee: 'ui/bee_a.png' }, // 128x128
  world: { grass: 'ui/world_grass.jpg', stone: 'ui/world_stone.jpg', sky: 'ui/world_sky.jpg', sand: 'ui/world_sand.jpg' }, // 480x270 thumbnails
};

export const CREDITS = 'CREDITS.txt';

// ---------- Phaser helper (optional) ----------
// Texture keys: 'world' | 'chars' | 'fx' (atlases), 'bg:<path>' for background layers.
// Audio keys: 'sfx:<name>', 'music:<world>'.
export function preload(scene, { audio = true, music = true } = {}) {
  const L = scene.load;
  for (const [k, a] of Object.entries(ATLASES)) L.atlas(k, BASE + a.png, BASE + a.json);
  const bgs = new Set(); for (const t of Object.values(THEMES)) t.bg.forEach((p) => bgs.add(p));
  for (const p of bgs) L.image('bg:' + p, BASE + p);
  if (audio) for (const [k, p] of Object.entries(SFX)) L.audio('sfx:' + k, BASE + p);
  if (music) for (const [k, p] of Object.entries(MUSIC)) L.audio('music:' + k, BASE + p);
}

/** Every file path (relative to BASE) referenced here – handy for a service-worker precache list / tests. */
export function allPaths() {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { if (/\.(png|jpg|json|mp3|txt)$/.test(v)) out.add(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(ATLASES); walk(THEMES); walk(BG_FULL); walk(SFX); walk(MUSIC); walk(UI); out.add(CREDITS);
  return [...out];
}
