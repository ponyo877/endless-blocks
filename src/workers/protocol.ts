// Messages between main <-> owner <-> compute workers.

export interface GenJob {
  type: 'gen';
  cx: number;
  cz: number;
}

export interface MeshJob {
  type: 'mesh';
  cx: number;
  cz: number;
  H: number;
  region: Uint8Array; // 48 x H x 48
  epoch: number;
}

export interface GenResult {
  type: 'gen';
  cx: number;
  cz: number;
  blocks: Uint8Array;
  heights: Int16Array;
  topIds: Uint8Array;
  biomes: Uint8Array;
  ms: number;
}

export interface MeshDone {
  type: 'meshDone';
  cx: number;
  cz: number;
  ms: number;
}

export interface MeshResult {
  type: 'mesh';
  cx: number;
  cz: number;
  epoch: number;
  opaque: Uint32Array;
  cutout: Uint32Array;
  translucent: Uint32Array;
  /** leaf cubes: alpha-tested near the camera, drawn opaque ("fast") further away */
  leaves: Uint32Array;
  minY: number;
  maxY: number;
  /** per column summary for ambience/HUD: heights (Int16) and top block ids */
  heights: Int16Array;
  topIds: Uint8Array;
  biomes: Uint8Array;
}

/** main -> owner: chunks main wants meshes for, in priority order (flat [cx,cz,...]) */
export interface WantMsg {
  type: 'want';
  list: Int32Array;
  ccx: number;
  ccz: number;
  keep: number;
  epoch: number;
}

export interface CreditMsg {
  type: 'credit';
  n: number;
}

export function ckey(cx: number, cz: number): number {
  return (cx + 1048576) * 2097152 + (cz + 1048576);
}
