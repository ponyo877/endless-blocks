export const CHUNK = 16;
export const HEIGHT = 320;
export const SECTION = 16;
export const SECTIONS = HEIGHT / SECTION;
export const SEA = 63; // water fills y < SEA
export const CHUNK_VOLUME = CHUNK * CHUNK * HEIGHT;
export const CELL_XZ = 4;
export const CELL_Y = 8;
export const CELLS_Y = HEIGHT / CELL_Y; // 40
export const CORNERS_Y = CELLS_Y + 1; // 41

/** index into a chunk column array: y-major so y-ranges are contiguous slabs */
export function idx(x: number, y: number, z: number): number {
  return (y << 8) | (z << 4) | x;
}
