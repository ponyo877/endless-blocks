import { layerOf } from './textureNames';

// Block registry as flat typed arrays (fast lookup in workers).

export const B = {
  AIR: 0,
  STONE: 1,
  GRASS: 2,
  DIRT: 3,
  COBBLESTONE: 4,
  BEDROCK: 5,
  SAND: 6,
  GRAVEL: 7,
  SANDSTONE: 8,
  WATER: 9,
  LAVA: 10,
  SNOW: 11,
  SNOW_LAYER: 12,
  ICE: 13,
  PACKED_ICE: 14,
  BLUE_ICE: 15,
  CLAY: 16,
  COARSE_DIRT: 17,
  PODZOL: 18,
  MYCELIUM: 19,
  GRASS_SNOWY: 20,
  RED_SAND: 21,
  TERRACOTTA: 22,
  T_ORANGE: 23,
  T_YELLOW: 24,
  T_RED: 25,
  T_WHITE: 26,
  T_BROWN: 27,
  T_LGRAY: 28,
  MOSSY_COBBLE: 29,
  MOSS: 30,
  OBSIDIAN: 31,
  COAL_ORE: 32,
  IRON_ORE: 33,
  COPPER_ORE: 34,
  GOLD_ORE: 35,
  GEM_ORE: 36,
  DIRT_PATH: 37,
  FARMLAND: 38,

  OAK_LOG: 40,
  OAK_LEAVES: 41,
  BIRCH_LOG: 42,
  BIRCH_LEAVES: 43,
  SPRUCE_LOG: 44,
  SPRUCE_LEAVES: 45,
  JUNGLE_LOG: 46,
  JUNGLE_LEAVES: 47,
  ACACIA_LOG: 48,
  ACACIA_LEAVES: 49,
  DARK_OAK_LOG: 50,
  DARK_OAK_LEAVES: 51,
  CHERRY_LOG: 52,
  CHERRY_LEAVES: 53,
  MUSHROOM_STEM: 54,
  RED_MUSHROOM_BLOCK: 55,
  BROWN_MUSHROOM_BLOCK: 56,
  OAK_PLANKS: 57,
  SPRUCE_PLANKS: 58,

  SHORT_GRASS: 60,
  FERN: 61,
  TALL_GRASS: 62,
  TALL_GRASS_TOP: 63,
  DANDELION: 64,
  POPPY: 65,
  CORNFLOWER: 66,
  OXEYE: 67,
  ALLIUM: 68,
  ORANGE_TULIP: 69,
  PINK_TULIP: 70,
  LILAC: 71,
  LILAC_TOP: 72,
  DEAD_BUSH: 73,
  SUGAR_CANE: 74,
  CACTUS: 75,
  LILY_PAD: 76,
  SEAGRASS: 77,
  KELP: 78,
  RED_MUSHROOM: 79,
  BROWN_MUSHROOM: 80,
  VINE_N: 81,
  VINE_S: 82,
  VINE_E: 83,
  VINE_W: 84,
  WHEAT: 85,

  CORAL_TUBE: 90,
  CORAL_BRAIN: 91,
  CORAL_BUBBLE: 92,
  CORAL_FIRE: 93,
  CORAL_HORN: 94,

  STONE_BRICKS: 100,
  MOSSY_STONE_BRICKS: 101,
  BRICKS: 102,
  GLASS: 103,
  HAY: 104,
  LANTERN: 105,
  GLOW_LAMP: 106,
  WHITE_WOOL: 107,
  BOOKSHELF: 109,
  PUMPKIN: 110,
  MELON: 111,
} as const;

export const Shape = {
  NONE: 0,
  CUBE: 1,
  CROSS: 2,
  LIQUID: 3,
  SNOW_LAYER: 4,
  FLAT: 5,
  CACTUS: 6,
  PATH: 7,
  VINE: 8,
  LANTERN: 9,
} as const;

export const Render = { NONE: 0, OPAQUE: 1, CUTOUT: 2, TRANSLUCENT: 3 } as const;

export const Tint = { NONE: 0, GRASS: 1, FOLIAGE: 2, WATER: 3, BIRCH: 4, SPRUCE: 5, LILY: 6 } as const;

export const MAX_BLOCKS = 256;

/** full opaque cube: culls neighbour faces, blocks light, casts AO */
export const OPAQUE = new Uint8Array(MAX_BLOCKS);
export const RENDER = new Uint8Array(MAX_BLOCKS);
export const SHAPE = new Uint8Array(MAX_BLOCKS);
/** extra light attenuation when light passes through (0 for air/plants, 1 leaves/water, 15 opaque) */
export const FILTER = new Uint8Array(MAX_BLOCKS);
export const EMIT = new Uint8Array(MAX_BLOCKS);
export const TINT = new Uint8Array(MAX_BLOCKS);
/** treated as water for water-face culling (water, seagrass, kelp) */
export const WATERY = new Uint8Array(MAX_BLOCKS);
/** can be overwritten by tree leaves / logs */
export const REPLACEABLE = new Uint8Array(MAX_BLOCKS);
/** casts ambient occlusion */
export const AO_OCC = new Uint8Array(MAX_BLOCKS);
/** solid ground for collision / planner purposes (anything you could not fly through) */
export const SOLID = new Uint8Array(MAX_BLOCKS);
/** face texture layers: TEX[id*6+face], faces: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z */
export const TEX = new Uint16Array(MAX_BLOCKS * 6);
/** animated frame count of the base texture layer (1 = static) */
export const ANIM = new Uint8Array(MAX_BLOCKS);
export const NAMES: string[] = new Array(MAX_BLOCKS).fill('');

interface Def {
  tex?: string; // all faces
  top?: string;
  bottom?: string;
  side?: string;
  shape?: number;
  render?: number;
  filter?: number;
  emit?: number;
  tint?: number;
  watery?: boolean;
  replaceable?: boolean;
  solid?: boolean;
  anim?: number;
}

function def(id: number, name: string, d: Def): void {
  const shape = d.shape ?? Shape.CUBE;
  const render = d.render ?? Render.OPAQUE;
  NAMES[id] = name;
  SHAPE[id] = shape;
  RENDER[id] = render;
  OPAQUE[id] = shape === Shape.CUBE && render === Render.OPAQUE ? 1 : 0;
  FILTER[id] = d.filter ?? (OPAQUE[id] ? 15 : 0);
  EMIT[id] = d.emit ?? 0;
  TINT[id] = d.tint ?? Tint.NONE;
  WATERY[id] = d.watery ? 1 : 0;
  REPLACEABLE[id] = d.replaceable ? 1 : 0;
  AO_OCC[id] = OPAQUE[id];
  SOLID[id] = d.solid !== undefined ? (d.solid ? 1 : 0) : shape === Shape.CUBE || shape === Shape.CACTUS || shape === Shape.PATH ? 1 : 0;
  ANIM[id] = d.anim ?? 1;
  const side = d.side ?? d.tex ?? name;
  const top = d.top ?? d.tex ?? side;
  const bottom = d.bottom ?? d.tex ?? top;
  const s = layerOf(side);
  TEX[id * 6 + 0] = s;
  TEX[id * 6 + 1] = s;
  TEX[id * 6 + 2] = layerOf(top);
  TEX[id * 6 + 3] = layerOf(bottom);
  TEX[id * 6 + 4] = s;
  TEX[id * 6 + 5] = s;
}

const cutout = { render: Render.CUTOUT };
const plant = { shape: Shape.CROSS, render: Render.CUTOUT, replaceable: true, solid: false };
const leaves = (tex: string, tint: number) => ({ tex, render: Render.CUTOUT, filter: 1, tint, solid: true });

// AIR has no texture; give it a harmless default.
NAMES[B.AIR] = 'air';
REPLACEABLE[B.AIR] = 1;

def(B.STONE, 'stone', { tex: 'stone' });
def(B.GRASS, 'grass', { top: 'grass_top', side: 'grass_side', bottom: 'dirt', tint: Tint.GRASS });
def(B.DIRT, 'dirt', { tex: 'dirt' });
def(B.COBBLESTONE, 'cobblestone', { tex: 'cobblestone' });
def(B.BEDROCK, 'bedrock', { tex: 'bedrock' });
def(B.SAND, 'sand', { tex: 'sand' });
def(B.GRAVEL, 'gravel', { tex: 'gravel' });
def(B.SANDSTONE, 'sandstone', { top: 'sandstone_top', side: 'sandstone_side', bottom: 'sandstone_bottom' });
def(B.WATER, 'water', { tex: 'water', shape: Shape.LIQUID, render: Render.TRANSLUCENT, filter: 1, tint: Tint.WATER, watery: true, solid: false, anim: 16 });
def(B.LAVA, 'lava', { tex: 'lava', shape: Shape.LIQUID, render: Render.OPAQUE, filter: 15, emit: 15, solid: false, anim: 16 });
def(B.SNOW, 'snow', { tex: 'snow' });
def(B.SNOW_LAYER, 'snow_layer', { tex: 'snow', shape: Shape.SNOW_LAYER, render: Render.OPAQUE, replaceable: true, solid: false });
def(B.ICE, 'ice', { tex: 'ice', render: Render.TRANSLUCENT, filter: 1 });
def(B.PACKED_ICE, 'packed_ice', { tex: 'packed_ice' });
def(B.BLUE_ICE, 'blue_ice', { tex: 'blue_ice' });
def(B.CLAY, 'clay', { tex: 'clay' });
def(B.COARSE_DIRT, 'coarse_dirt', { tex: 'coarse_dirt' });
def(B.PODZOL, 'podzol', { top: 'podzol_top', side: 'podzol_side', bottom: 'dirt' });
def(B.MYCELIUM, 'mycelium', { top: 'mycelium_top', side: 'mycelium_side', bottom: 'dirt' });
def(B.GRASS_SNOWY, 'grass_snowy', { top: 'snow', side: 'grass_side_snowy', bottom: 'dirt' });
def(B.RED_SAND, 'red_sand', { tex: 'red_sand' });
def(B.TERRACOTTA, 'terracotta', { tex: 'terracotta' });
def(B.T_ORANGE, 'terracotta_orange', { tex: 'terracotta_orange' });
def(B.T_YELLOW, 'terracotta_yellow', { tex: 'terracotta_yellow' });
def(B.T_RED, 'terracotta_red', { tex: 'terracotta_red' });
def(B.T_WHITE, 'terracotta_white', { tex: 'terracotta_white' });
def(B.T_BROWN, 'terracotta_brown', { tex: 'terracotta_brown' });
def(B.T_LGRAY, 'terracotta_light_gray', { tex: 'terracotta_light_gray' });
def(B.MOSSY_COBBLE, 'mossy_cobblestone', { tex: 'mossy_cobblestone' });
def(B.MOSS, 'moss_block', { tex: 'moss_block' });
def(B.OBSIDIAN, 'obsidian', { tex: 'obsidian' });
def(B.COAL_ORE, 'coal_ore', { tex: 'coal_ore' });
def(B.IRON_ORE, 'iron_ore', { tex: 'iron_ore' });
def(B.COPPER_ORE, 'copper_ore', { tex: 'copper_ore' });
def(B.GOLD_ORE, 'gold_ore', { tex: 'gold_ore' });
def(B.GEM_ORE, 'gem_ore', { tex: 'gem_ore' });
def(B.DIRT_PATH, 'dirt_path', { top: 'dirt_path_top', side: 'dirt_path_side', bottom: 'dirt', shape: Shape.PATH });
def(B.FARMLAND, 'farmland', { top: 'farmland_top', side: 'dirt', bottom: 'dirt', shape: Shape.PATH });

def(B.OAK_LOG, 'oak_log', { side: 'oak_log', top: 'oak_log_top' });
def(B.OAK_LEAVES, 'oak_leaves', leaves('oak_leaves', Tint.FOLIAGE));
def(B.BIRCH_LOG, 'birch_log', { side: 'birch_log', top: 'birch_log_top' });
def(B.BIRCH_LEAVES, 'birch_leaves', leaves('birch_leaves', Tint.BIRCH));
def(B.SPRUCE_LOG, 'spruce_log', { side: 'spruce_log', top: 'spruce_log_top' });
def(B.SPRUCE_LEAVES, 'spruce_leaves', leaves('spruce_leaves', Tint.SPRUCE));
def(B.JUNGLE_LOG, 'jungle_log', { side: 'jungle_log', top: 'jungle_log_top' });
def(B.JUNGLE_LEAVES, 'jungle_leaves', leaves('jungle_leaves', Tint.FOLIAGE));
def(B.ACACIA_LOG, 'acacia_log', { side: 'acacia_log', top: 'acacia_log_top' });
def(B.ACACIA_LEAVES, 'acacia_leaves', leaves('acacia_leaves', Tint.FOLIAGE));
def(B.DARK_OAK_LOG, 'dark_oak_log', { side: 'dark_oak_log', top: 'dark_oak_log_top' });
def(B.DARK_OAK_LEAVES, 'dark_oak_leaves', leaves('dark_oak_leaves', Tint.FOLIAGE));
def(B.CHERRY_LOG, 'cherry_log', { side: 'cherry_log', top: 'cherry_log_top' });
def(B.CHERRY_LEAVES, 'cherry_leaves', leaves('cherry_leaves', Tint.NONE));
def(B.MUSHROOM_STEM, 'mushroom_stem', { tex: 'mushroom_stem' });
def(B.RED_MUSHROOM_BLOCK, 'red_mushroom_block', { tex: 'red_mushroom_block' });
def(B.BROWN_MUSHROOM_BLOCK, 'brown_mushroom_block', { tex: 'brown_mushroom_block' });
def(B.OAK_PLANKS, 'oak_planks', { tex: 'oak_planks' });
def(B.SPRUCE_PLANKS, 'spruce_planks', { tex: 'spruce_planks' });

def(B.SHORT_GRASS, 'short_grass', { ...plant, tex: 'short_grass', tint: Tint.GRASS });
def(B.FERN, 'fern', { ...plant, tex: 'fern', tint: Tint.GRASS });
def(B.TALL_GRASS, 'tall_grass', { ...plant, tex: 'tall_grass_bottom', tint: Tint.GRASS });
def(B.TALL_GRASS_TOP, 'tall_grass_top', { ...plant, tex: 'tall_grass_top', tint: Tint.GRASS });
def(B.DANDELION, 'dandelion', { ...plant, tex: 'dandelion' });
def(B.POPPY, 'poppy', { ...plant, tex: 'poppy' });
def(B.CORNFLOWER, 'cornflower', { ...plant, tex: 'cornflower' });
def(B.OXEYE, 'oxeye_daisy', { ...plant, tex: 'oxeye_daisy' });
def(B.ALLIUM, 'allium', { ...plant, tex: 'allium' });
def(B.ORANGE_TULIP, 'orange_tulip', { ...plant, tex: 'orange_tulip' });
def(B.PINK_TULIP, 'pink_tulip', { ...plant, tex: 'pink_tulip' });
def(B.LILAC, 'lilac', { ...plant, tex: 'lilac_bottom' });
def(B.LILAC_TOP, 'lilac_top', { ...plant, tex: 'lilac_top' });
def(B.DEAD_BUSH, 'dead_bush', { ...plant, tex: 'dead_bush' });
def(B.SUGAR_CANE, 'sugar_cane', { ...plant, tex: 'sugar_cane', solid: true });
def(B.CACTUS, 'cactus', { side: 'cactus_side', top: 'cactus_top', bottom: 'cactus_top', shape: Shape.CACTUS, render: Render.CUTOUT, solid: true });
def(B.LILY_PAD, 'lily_pad', { tex: 'lily_pad', shape: Shape.FLAT, render: Render.CUTOUT, tint: Tint.LILY, solid: false });
def(B.SEAGRASS, 'seagrass', { ...plant, tex: 'seagrass', watery: true, filter: 1 });
def(B.KELP, 'kelp', { ...plant, tex: 'kelp', watery: true, filter: 1 });
def(B.RED_MUSHROOM, 'red_mushroom', { ...plant, tex: 'red_mushroom' });
def(B.BROWN_MUSHROOM, 'brown_mushroom', { ...plant, tex: 'brown_mushroom', emit: 1 });
for (const v of [B.VINE_N, B.VINE_S, B.VINE_E, B.VINE_W]) {
  def(v, 'vine', { tex: 'vine', shape: Shape.VINE, render: Render.CUTOUT, tint: Tint.FOLIAGE, replaceable: true, solid: false });
}
def(B.WHEAT, 'wheat', { ...plant, tex: 'wheat' });

def(B.CORAL_TUBE, 'coral_tube', { tex: 'coral_tube' });
def(B.CORAL_BRAIN, 'coral_brain', { tex: 'coral_brain' });
def(B.CORAL_BUBBLE, 'coral_bubble', { tex: 'coral_bubble' });
def(B.CORAL_FIRE, 'coral_fire', { tex: 'coral_fire' });
def(B.CORAL_HORN, 'coral_horn', { tex: 'coral_horn' });

def(B.STONE_BRICKS, 'stone_bricks', { tex: 'stone_bricks' });
def(B.MOSSY_STONE_BRICKS, 'mossy_stone_bricks', { tex: 'mossy_stone_bricks' });
def(B.BRICKS, 'bricks', { tex: 'bricks' });
def(B.GLASS, 'glass', { tex: 'glass', ...cutout });
def(B.HAY, 'hay', { side: 'hay_side', top: 'hay_top' });
def(B.LANTERN, 'lantern', { tex: 'lantern', shape: Shape.LANTERN, render: Render.CUTOUT, emit: 15, solid: false });
def(B.GLOW_LAMP, 'glow_lamp', { tex: 'glow_lamp', emit: 15 });
def(B.WHITE_WOOL, 'white_wool', { tex: 'white_wool' });
def(B.BOOKSHELF, 'bookshelf', { side: 'bookshelf', top: 'oak_planks' });
def(B.PUMPKIN, 'pumpkin', { side: 'pumpkin_side', top: 'pumpkin_top', bottom: 'pumpkin_top' });
def(B.MELON, 'melon', { side: 'melon_side', top: 'melon_side' });

// Leaves occlude AO too (gives canopies depth), but do not cull neighbour faces.
for (const id of [B.OAK_LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES, B.JUNGLE_LEAVES, B.ACACIA_LEAVES, B.DARK_OAK_LEAVES, B.CHERRY_LEAVES]) {
  AO_OCC[id] = 1;
}

export function isLeaves(id: number): boolean {
  return id === B.OAK_LEAVES || id === B.BIRCH_LEAVES || id === B.SPRUCE_LEAVES || id === B.JUNGLE_LEAVES ||
    id === B.ACACIA_LEAVES || id === B.DARK_OAK_LEAVES || id === B.CHERRY_LEAVES;
}

/**
 * Collision class for the game: 0 = fly through (air, plants, vines, snow layers, lanterns),
 * 1 = solid, 2 = leaves (solid, but scored and drawn differently), 3 = liquid (water and lava).
 */
export const Coll = { PASS: 0, SOLID: 1, LEAVES: 2, LIQUID: 3 } as const;
export const COLL = new Uint8Array(MAX_BLOCKS);
for (let id = 0; id < MAX_BLOCKS; id++) {
  if (id === B.WATER || id === B.LAVA || WATERY[id]) COLL[id] = Coll.LIQUID;
  else if (isLeaves(id)) COLL[id] = Coll.LEAVES;
  else if (SOLID[id]) COLL[id] = Coll.SOLID;
}
