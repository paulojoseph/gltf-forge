/**
 * Hand-written types for the glTF 2.0 JSON schema.
 *
 * These are declarations only. They produce no runtime code, which is what keeps
 * gltf-forge free of runtime dependencies (see docs/adr/0001-no-runtime-dependencies.md).
 * Fields mirror the names and optionality in the Khronos specification.
 */

export type Extensions = Record<string, unknown>;

export interface GltfProperty {
  extensions?: Extensions;
  extras?: unknown;
}

export interface GltfChildOfRoot extends GltfProperty {
  name?: string;
}

export interface GltfAssetInfo extends GltfProperty {
  version: string;
  minVersion?: string;
  generator?: string;
  copyright?: string;
}

export interface GltfBuffer extends GltfChildOfRoot {
  uri?: string;
  byteLength: number;
}

export interface GltfBufferView extends GltfChildOfRoot {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}

export type AccessorType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';

export interface GltfAccessorSparse extends GltfProperty {
  count: number;
  indices: GltfProperty & { bufferView: number; byteOffset?: number; componentType: number };
  values: GltfProperty & { bufferView: number; byteOffset?: number };
}

export interface GltfAccessor extends GltfChildOfRoot {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: AccessorType;
  max?: number[];
  min?: number[];
  sparse?: GltfAccessorSparse;
}

export interface GltfImage extends GltfChildOfRoot {
  uri?: string;
  mimeType?: string;
  bufferView?: number;
}

export interface GltfSampler extends GltfChildOfRoot {
  magFilter?: number;
  minFilter?: number;
  wrapS?: number;
  wrapT?: number;
}

export interface GltfTexture extends GltfChildOfRoot {
  sampler?: number;
  source?: number;
}

export interface GltfTextureInfo extends GltfProperty {
  index: number;
  texCoord?: number;
}

export interface GltfNormalTextureInfo extends GltfTextureInfo {
  scale?: number;
}

export interface GltfOcclusionTextureInfo extends GltfTextureInfo {
  strength?: number;
}

export interface GltfPbrMetallicRoughness extends GltfProperty {
  baseColorFactor?: number[];
  baseColorTexture?: GltfTextureInfo;
  metallicFactor?: number;
  roughnessFactor?: number;
  metallicRoughnessTexture?: GltfTextureInfo;
}

export interface GltfMaterial extends GltfChildOfRoot {
  pbrMetallicRoughness?: GltfPbrMetallicRoughness;
  normalTexture?: GltfNormalTextureInfo;
  occlusionTexture?: GltfOcclusionTextureInfo;
  emissiveTexture?: GltfTextureInfo;
  emissiveFactor?: number[];
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  doubleSided?: boolean;
}

export interface GltfPrimitive extends GltfProperty {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Record<string, number>[];
}

export interface GltfMesh extends GltfChildOfRoot {
  primitives: GltfPrimitive[];
  weights?: number[];
}

export interface GltfNode extends GltfChildOfRoot {
  camera?: number;
  children?: number[];
  skin?: number;
  matrix?: number[];
  mesh?: number;
  rotation?: number[];
  scale?: number[];
  translation?: number[];
  weights?: number[];
}

export interface GltfScene extends GltfChildOfRoot {
  nodes?: number[];
}

export interface GltfSkin extends GltfChildOfRoot {
  inverseBindMatrices?: number;
  skeleton?: number;
  joints: number[];
}

export interface GltfAnimationSampler extends GltfProperty {
  input: number;
  interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
  output: number;
}

export interface GltfAnimationChannel extends GltfProperty {
  sampler: number;
  target: GltfProperty & { node?: number; path: string };
}

export interface GltfAnimation extends GltfChildOfRoot {
  channels: GltfAnimationChannel[];
  samplers: GltfAnimationSampler[];
}

export interface GltfCamera extends GltfChildOfRoot {
  type: 'perspective' | 'orthographic';
  perspective?: GltfProperty & {
    aspectRatio?: number;
    yfov: number;
    zfar?: number;
    znear: number;
  };
  orthographic?: GltfProperty & {
    xmag: number;
    ymag: number;
    zfar: number;
    znear: number;
  };
}

export interface GltfRoot extends GltfProperty {
  asset: GltfAssetInfo;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  scene?: number;
  scenes?: GltfScene[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  materials?: GltfMaterial[];
  textures?: GltfTexture[];
  images?: GltfImage[];
  samplers?: GltfSampler[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: GltfBuffer[];
  skins?: GltfSkin[];
  animations?: GltfAnimation[];
  cameras?: GltfCamera[];
}

/** Accessor component types, as numbered by OpenGL and the glTF spec. */
export const ComponentType = {
  Byte: 5120,
  UnsignedByte: 5121,
  Short: 5122,
  UnsignedShort: 5123,
  UnsignedInt: 5125,
  Float: 5126,
} as const;

/** Primitive topology, as numbered in the glTF spec. */
export const PrimitiveMode = {
  Points: 0,
  Lines: 1,
  LineLoop: 2,
  LineStrip: 3,
  Triangles: 4,
  TriangleStrip: 5,
  TriangleFan: 6,
} as const;
