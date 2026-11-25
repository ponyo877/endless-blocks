import * as THREE from 'three';
import type { TextureSet } from './textures';

export function createTextureArrays(set: TextureSet): { color: THREE.DataArrayTexture; mask: THREE.DataArrayTexture } {
  const color = new THREE.DataArrayTexture(set.rgba, 16, 16, set.layers);
  color.format = THREE.RGBAFormat;
  color.type = THREE.UnsignedByteType;
  color.magFilter = THREE.NearestFilter;
  color.minFilter = THREE.NearestMipmapLinearFilter;
  color.generateMipmaps = true;
  color.colorSpace = THREE.NoColorSpace;
  color.wrapS = THREE.RepeatWrapping;
  color.wrapT = THREE.RepeatWrapping;
  color.needsUpdate = true;

  const mask = new THREE.DataArrayTexture(set.mask, 16, 16, set.layers);
  mask.format = THREE.RedFormat;
  mask.type = THREE.UnsignedByteType;
  mask.magFilter = THREE.NearestFilter;
  mask.minFilter = THREE.NearestFilter;
  mask.generateMipmaps = false;
  mask.colorSpace = THREE.NoColorSpace;
  mask.unpackAlignment = 1;
  mask.needsUpdate = true;
  return { color, mask };
}
