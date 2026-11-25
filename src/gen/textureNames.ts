// Canonical list of 16x16 texture layers. The ORDER defines the layer index in the
// DataArrayTexture; workers compute layer indices from this list without generating pixels.
// `frames` > 1 means an animated texture occupying `frames` consecutive layers.
// `tint` means the texture is authored light/greyscale so it can be multiplied by a biome colour,
// and its tint mask should be 255 where the tint applies (see textures.ts).

export interface TextureSpec {
  name: string;
  desc: string;
  frames?: number;
  tint?: 'full' | 'partial';
  alpha?: 'cutout' | 'translucent';
}

export const TEXTURES: TextureSpec[] = [
  // ---- natural terrain ----
  { name: 'stone', desc: 'mid grey natural stone, subtle darker/lighter irregular patches' },
  { name: 'cobblestone', desc: 'irregular rounded grey stones separated by dark mortar' },
  { name: 'mossy_cobblestone', desc: 'cobblestone with green moss patches' },
  { name: 'bedrock', desc: 'very dark/black and grey chaotic noise' },
  { name: 'dirt', desc: 'brown soil with darker and lighter specks' },
  { name: 'coarse_dirt', desc: 'dirt mixed with small grey-brown gravel bits' },
  { name: 'grass_top', desc: 'greyscale grass top (tinted by biome grass colour)', tint: 'full' },
  { name: 'grass_side', desc: 'dirt side with an irregular grass fringe on the top 3-4 rows; fringe greyscale & tinted, dirt not tinted', tint: 'partial' },
  { name: 'grass_side_snowy', desc: 'dirt side with white snow fringe on the top 3-4 rows (no tint)' },
  { name: 'podzol_top', desc: 'brown-orange forest floor with dark needles' },
  { name: 'podzol_side', desc: 'dirt with podzol fringe at top' },
  { name: 'mycelium_top', desc: 'grey-purple fungal ground with light specks' },
  { name: 'mycelium_side', desc: 'dirt with grey-purple fringe at top' },
  { name: 'dirt_path_top', desc: 'packed tan/brown path surface' },
  { name: 'dirt_path_side', desc: 'dirt side with path fringe at top (block is 15/16 tall)' },
  { name: 'farmland_top', desc: 'dark wet tilled soil with furrow lines' },
  { name: 'sand', desc: 'pale yellow beige sand with fine specks' },
  { name: 'red_sand', desc: 'orange-red sand with fine specks' },
  { name: 'gravel', desc: 'mixed grey/brownish pebbles' },
  { name: 'clay', desc: 'smooth blue-grey clay with very subtle noise' },
  { name: 'sandstone_top', desc: 'smooth pale sandstone top' },
  { name: 'sandstone_side', desc: 'pale sandstone with horizontal layers, darker band near the bottom' },
  { name: 'sandstone_bottom', desc: 'pale sandstone bottom, slightly rougher' },
  { name: 'snow', desc: 'white snow with faint blue-grey specks' },
  { name: 'ice', desc: 'light blue translucent ice with a few white streaks (alpha ~170-200)', alpha: 'translucent' },
  { name: 'packed_ice', desc: 'opaque pale blue ice with cracks' },
  { name: 'blue_ice', desc: 'opaque deeper blue ice with cracks' },
  { name: 'terracotta', desc: 'plain brownish-orange baked clay, flat with tiny noise' },
  { name: 'terracotta_orange', desc: 'orange terracotta' },
  { name: 'terracotta_yellow', desc: 'ochre yellow terracotta' },
  { name: 'terracotta_red', desc: 'brick red terracotta' },
  { name: 'terracotta_white', desc: 'pale pinkish-white terracotta' },
  { name: 'terracotta_brown', desc: 'dark brown terracotta' },
  { name: 'terracotta_light_gray', desc: 'light grey-mauve terracotta' },
  { name: 'moss_block', desc: 'dense green moss' },
  { name: 'obsidian', desc: 'very dark purple-black with lighter purple glints' },
  { name: 'coal_ore', desc: 'stone with black coal clusters' },
  { name: 'iron_ore', desc: 'stone with beige/tan iron clusters' },
  { name: 'copper_ore', desc: 'stone with orange and teal-green copper clusters' },
  { name: 'gold_ore', desc: 'stone with bright yellow gold clusters' },
  { name: 'gem_ore', desc: 'stone with bright cyan gem clusters' },
  { name: 'water', desc: 'animated still water, light greyscale-blue ripples, tinted by biome water colour; alpha ~180', frames: 16, tint: 'full', alpha: 'translucent' },
  { name: 'lava', desc: 'animated lava, orange/yellow/red flowing blobs, fully opaque', frames: 16 },

  // ---- wood ----
  { name: 'oak_log', desc: 'oak bark: brown with vertical dark grooves' },
  { name: 'oak_log_top', desc: 'oak log end: tan rings with bark border' },
  { name: 'oak_leaves', desc: 'greyscale dense leaves with ~20% transparent holes (tinted by foliage colour)', tint: 'full', alpha: 'cutout' },
  { name: 'oak_planks', desc: 'light brown planks, 4 horizontal boards with seams and offsets' },
  { name: 'birch_log', desc: 'birch bark: white/cream with black horizontal marks' },
  { name: 'birch_log_top', desc: 'birch log end: pale rings with white bark border' },
  { name: 'birch_leaves', desc: 'greyscale leaves (tinted fixed light green)', tint: 'full', alpha: 'cutout' },
  { name: 'spruce_log', desc: 'spruce bark: dark brown with vertical grooves' },
  { name: 'spruce_log_top', desc: 'spruce log end' },
  { name: 'spruce_leaves', desc: 'greyscale needle leaves, denser, darker (tinted fixed blue-green)', tint: 'full', alpha: 'cutout' },
  { name: 'spruce_planks', desc: 'dark brown planks' },
  { name: 'jungle_log', desc: 'jungle bark: brown with greenish streaks' },
  { name: 'jungle_log_top', desc: 'jungle log end' },
  { name: 'jungle_leaves', desc: 'greyscale large-lobed leaves (tinted)', tint: 'full', alpha: 'cutout' },
  { name: 'acacia_log', desc: 'acacia bark: grey with lighter streaks' },
  { name: 'acacia_log_top', desc: 'acacia log end: orange rings' },
  { name: 'acacia_leaves', desc: 'greyscale sparse leaves (tinted)', tint: 'full', alpha: 'cutout' },
  { name: 'dark_oak_log', desc: 'dark oak bark: very dark brown' },
  { name: 'dark_oak_log_top', desc: 'dark oak log end' },
  { name: 'dark_oak_leaves', desc: 'greyscale dense leaves (tinted)', tint: 'full', alpha: 'cutout' },
  { name: 'cherry_log', desc: 'cherry bark: dark maroon-brown' },
  { name: 'cherry_log_top', desc: 'cherry log end: pinkish rings' },
  { name: 'cherry_leaves', desc: 'pink blossom leaves (NOT tinted) with transparent holes and a few lighter petals', alpha: 'cutout' },
  { name: 'mushroom_stem', desc: 'off-white mushroom stem with faint vertical lines' },
  { name: 'red_mushroom_block', desc: 'red cap with white spots' },
  { name: 'brown_mushroom_block', desc: 'brown cap, mottled' },

  // ---- plants (cutout sprites drawn on transparent background) ----
  { name: 'short_grass', desc: 'cluster of greyscale grass blades rising from the bottom (tinted)', tint: 'full', alpha: 'cutout' },
  { name: 'fern', desc: 'greyscale fern fronds (tinted)', tint: 'full', alpha: 'cutout' },
  { name: 'tall_grass_bottom', desc: 'lower half of tall grass, dense blades filling the tile (tinted)', tint: 'full', alpha: 'cutout' },
  { name: 'tall_grass_top', desc: 'upper half of tall grass, blades tapering to tips (tinted)', tint: 'full', alpha: 'cutout' },
  { name: 'dandelion', desc: 'small yellow flower on green stem', alpha: 'cutout' },
  { name: 'poppy', desc: 'small red flower on green stem', alpha: 'cutout' },
  { name: 'cornflower', desc: 'small blue flower on green stem', alpha: 'cutout' },
  { name: 'oxeye_daisy', desc: 'white daisy with yellow centre', alpha: 'cutout' },
  { name: 'allium', desc: 'purple ball flower on tall stem', alpha: 'cutout' },
  { name: 'orange_tulip', desc: 'orange tulip', alpha: 'cutout' },
  { name: 'pink_tulip', desc: 'pink tulip', alpha: 'cutout' },
  { name: 'lilac_bottom', desc: 'lower half of a tall purple flowering bush (leaves + some flowers)', alpha: 'cutout' },
  { name: 'lilac_top', desc: 'upper half of a tall purple flowering bush (flower clusters)', alpha: 'cutout' },
  { name: 'dead_bush', desc: 'brown dry twiggy bush', alpha: 'cutout' },
  { name: 'sugar_cane', desc: 'light green segmented reed stalks', alpha: 'cutout' },
  { name: 'cactus_side', desc: 'green cactus side with darker vertical ribs and tiny spines; the outer 1px columns transparent (block is inset)', alpha: 'cutout' },
  { name: 'cactus_top', desc: 'cactus top: green with lighter centre' },
  { name: 'lily_pad', desc: 'greyscale round lily pad with a notch, seen from above (tinted)', tint: 'full', alpha: 'cutout' },
  { name: 'seagrass', desc: 'thin green underwater grass blades', alpha: 'cutout' },
  { name: 'kelp', desc: 'olive-green kelp strand with leaves', alpha: 'cutout' },
  { name: 'red_mushroom', desc: 'tiny red mushroom with white spots', alpha: 'cutout' },
  { name: 'brown_mushroom', desc: 'tiny brown mushroom', alpha: 'cutout' },
  { name: 'vine', desc: 'greyscale hanging vine strands (tinted), mostly transparent', tint: 'full', alpha: 'cutout' },
  { name: 'wheat', desc: 'ripe golden wheat stalks with grain heads', alpha: 'cutout' },
  { name: 'coral_tube', desc: 'blue coral block, porous', },
  { name: 'coral_brain', desc: 'pink coral block, maze pattern' },
  { name: 'coral_bubble', desc: 'purple coral block, bubbly' },
  { name: 'coral_fire', desc: 'red coral block' },
  { name: 'coral_horn', desc: 'yellow coral block' },

  // ---- building ----
  { name: 'stone_bricks', desc: 'grey stone bricks, 2 rows of rectangular bricks with mortar' },
  { name: 'mossy_stone_bricks', desc: 'stone bricks with moss' },
  { name: 'bricks', desc: 'red clay bricks with light mortar' },
  { name: 'glass', desc: 'clear glass: transparent interior, light thin frame and a couple of white glints', alpha: 'cutout' },
  { name: 'hay_top', desc: 'hay bale top: yellow straw with red-brown binding ring' },
  { name: 'hay_side', desc: 'hay bale side: yellow straw vertical with two horizontal bands' },
  { name: 'lantern', desc: 'small iron lantern with glowing yellow-orange core, centred, rest transparent', alpha: 'cutout' },
  { name: 'glow_lamp', desc: 'warm glowing lamp block: bright yellow-orange core with dark frame' },
  { name: 'white_wool', desc: 'white wool, soft fibrous noise' },
  { name: 'oak_door', desc: 'oak door with small window panes at top (single tile, used for both halves)', alpha: 'cutout' },
  { name: 'bookshelf', desc: 'oak bookshelf with coloured book spines' },
  { name: 'pumpkin_side', desc: 'orange pumpkin side with vertical ribs' },
  { name: 'pumpkin_top', desc: 'orange pumpkin top with stem' },
  { name: 'melon_side', desc: 'green melon with stripes' },

  // ---- sky sprites (sampled by the sky shader) ----
  { name: 'sun', desc: 'square sun: bright white-yellow core square (~8px) with a softer yellow halo filling the tile, alpha used as additive mask', alpha: 'translucent' },
  { name: 'moon', desc: '8 moon phases (full -> waning -> new -> waxing), pale grey-blue pixel moon with craters, black/transparent background', frames: 8, alpha: 'translucent' },
];

export interface LayerInfo {
  index: number;
  frames: number;
}

const _layers = new Map<string, LayerInfo>();
let _count = 0;
for (const t of TEXTURES) {
  const frames = t.frames ?? 1;
  _layers.set(t.name, { index: _count, frames });
  _count += frames;
}

export const TEXTURE_LAYER_COUNT = _count;

export function layerOf(name: string): number {
  const l = _layers.get(name);
  if (!l) throw new Error(`unknown texture ${name}`);
  return l.index;
}

export function layerInfo(name: string): LayerInfo {
  const l = _layers.get(name);
  if (!l) throw new Error(`unknown texture ${name}`);
  return l;
}
