import type { Asset } from './asset.js';
import { GltfError } from './errors.js';
import type { AccessorType, GltfAccessor } from './types.js';

export const COMPONENT_BYTES: Readonly<Record<number, number>> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

export const TYPE_COMPONENTS: Readonly<Record<AccessorType, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

const MATRIX_SIZE: Partial<Record<AccessorType, number>> = { MAT2: 2, MAT3: 3, MAT4: 4 };

export type AccessorValues = Int8Array | Uint8Array | Int16Array | Uint16Array | Uint32Array | Float32Array;

export interface AccessorData {
  count: number;
  componentCount: number;
  componentType: number;
  /** Flat, `count * componentCount` long, in the accessor's own component type. Not normalized. */
  values: AccessorValues;
}

/**
 * Byte size of one element. Matrix columns are padded to 4 bytes, which only
 * changes the size for MAT2 of bytes and MAT3 of bytes or shorts.
 */
export function elementByteSize(type: AccessorType, componentType: number): number | undefined {
  const componentBytes = COMPONENT_BYTES[componentType];
  const components = TYPE_COMPONENTS[type] as number | undefined;
  if (componentBytes === undefined || components === undefined) return undefined;
  const side = MATRIX_SIZE[type];
  if (side === undefined) return components * componentBytes;
  return side * columnStride(side, componentBytes);
}

function columnStride(rows: number, componentBytes: number): number {
  return Math.ceil((rows * componentBytes) / 4) * 4;
}

function allocate(componentType: number, length: number): AccessorValues {
  switch (componentType) {
    case 5120:
      return new Int8Array(length);
    case 5121:
      return new Uint8Array(length);
    case 5122:
      return new Int16Array(length);
    case 5123:
      return new Uint16Array(length);
    case 5125:
      return new Uint32Array(length);
    default:
      return new Float32Array(length);
  }
}

function readComponent(view: DataView, componentType: number, offset: number): number {
  switch (componentType) {
    case 5120:
      return view.getInt8(offset);
    case 5121:
      return view.getUint8(offset);
    case 5122:
      return view.getInt16(offset, true);
    case 5123:
      return view.getUint16(offset, true);
    case 5125:
      return view.getUint32(offset, true);
    default:
      return view.getFloat32(offset, true);
  }
}

/**
 * Reads an accessor into a typed array, honouring `byteStride` and matrix column padding.
 *
 * The whole accessor is copied into memory at once. That is fine for the sizes
 * this milestone deals with and is a known limit; streaming reads come later.
 * Sparse accessors are not supported and throw.
 */
export function readAccessor(asset: Asset, index: number): AccessorData {
  const fail = (message: string): GltfError => new GltfError('ACCESSOR_READ', `accessors[${index}]: ${message}`);
  const accessor: GltfAccessor | undefined = asset.json.accessors?.[index];
  if (accessor === undefined) throw fail(`it does not exist; the asset has ${asset.json.accessors?.length ?? 0} accessors.`);
  if (accessor.sparse !== undefined) throw fail('sparse accessors are not supported yet.');

  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  const components = TYPE_COMPONENTS[accessor.type] as number | undefined;
  const elementBytes = elementByteSize(accessor.type, accessor.componentType);
  if (componentBytes === undefined || components === undefined || elementBytes === undefined) {
    throw fail(`componentType ${accessor.componentType} with type "${accessor.type}" is not a valid combination.`);
  }
  if (!Number.isInteger(accessor.count) || accessor.count < 0) throw fail(`count ${accessor.count} is not a valid count.`);

  const values = allocate(accessor.componentType, accessor.count * components);
  if (accessor.bufferView === undefined) return { count: accessor.count, componentCount: components, componentType: accessor.componentType, values };

  const view = asset.json.bufferViews?.[accessor.bufferView];
  if (view === undefined) throw fail(`bufferViews[${accessor.bufferView}] does not exist.`);
  const buffer = asset.buffers[view.buffer];
  if (buffer === undefined || buffer === null) throw fail(`the data of buffers[${view.buffer}] is not available.`);

  const stride = view.byteStride ?? elementBytes;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const end = accessor.count === 0 ? start : start + stride * (accessor.count - 1) + elementBytes;
  if (end > buffer.byteLength) {
    throw fail(`it reads bytes ${start} to ${end} of buffers[${view.buffer}], which only holds ${buffer.byteLength} bytes.`);
  }

  const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const side = MATRIX_SIZE[accessor.type];
  const colBytes = side === undefined ? 0 : columnStride(side, componentBytes);
  for (let i = 0; i < accessor.count; i++) {
    const base = start + i * stride;
    for (let k = 0; k < components; k++) {
      const offset =
        side === undefined ? base + k * componentBytes : base + Math.floor(k / side) * colBytes + (k % side) * componentBytes;
      values[i * components + k] = readComponent(data, accessor.componentType, offset);
    }
  }
  return { count: accessor.count, componentCount: components, componentType: accessor.componentType, values };
}
