import { readAccessor, COMPONENT_BYTES, TYPE_COMPONENTS, elementByteSize, type AccessorData } from './accessors.js';
import type { Asset } from './asset.js';
import { GltfError } from './errors.js';
import { CHUNK_BIN } from './glb.js';
import { getImageBytes, readImageInfo } from './image-info.js';
import { classifyUri, decodeDataUri } from './uri.js';

export type Severity = 'error' | 'warning';

export type IssueCode =
  | 'ASSET_VERSION'
  | 'TYPE_MISMATCH'
  | 'INDEX_OUT_OF_RANGE'
  | 'EXTENSION_NOT_USED'
  | 'EXTENSION_UNSUPPORTED'
  | 'BUFFER_NO_DATA'
  | 'BUFFER_TOO_SHORT'
  | 'BUFFER_PADDING'
  | 'BUFFER_REMOTE'
  | 'BUFFER_URI'
  | 'BUFFER_VIEW_RANGE'
  | 'BUFFER_VIEW_STRIDE'
  | 'ACCESSOR_ENUM'
  | 'ACCESSOR_RANGE'
  | 'ACCESSOR_ALIGNMENT'
  | 'ACCESSOR_STRIDE'
  | 'ACCESSOR_MINMAX'
  | 'ACCESSOR_SPARSE_SKIPPED'
  | 'IMAGE_SOURCE'
  | 'IMAGE_MIME'
  | 'IMAGE_UNREADABLE'
  | 'SAMPLER_ENUM'
  | 'MATERIAL_VALUE'
  | 'PRIMITIVE_MODE'
  | 'PRIMITIVE_ATTRIBUTES'
  | 'PRIMITIVE_COUNT'
  | 'PRIMITIVE_INDICES'
  | 'PRIMITIVE_INDEX_RANGE'
  | 'NODE_TRANSFORM'
  | 'NODE_PARENT'
  | 'NODE_CYCLE'
  | 'ANIMATION'
  | 'CAMERA';

export interface Issue {
  severity: Severity;
  code: IssueCode;
  /** JSON Pointer to the offending value, for example `/meshes/0/primitives/1/indices`. */
  path: string;
  /** The same location written the way you would type it in code, for example `meshes[0].primitives[1].indices`. */
  location: string;
  message: string;
}

export interface ValidationResult {
  issues: Issue[];
  errors: number;
  warnings: number;
  /** True when there are no errors. Warnings do not fail validation. */
  ok: boolean;
}

type Obj = Record<string, unknown>;
type Path = (string | number)[];

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function pointer(path: Path): string {
  return path.map((part) => `/${String(part).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

function dotted(path: Path): string {
  let out = '';
  for (const part of path) out += typeof part === 'number' ? `[${part}]` : out === '' ? part : `.${part}`;
  return out;
}

function plural(count: number, noun: string): string {
  return count === 0 ? `no ${noun}` : `${count} ${noun}`;
}

const VALID_COMPONENT_TYPES = new Set([5120, 5121, 5122, 5123, 5125, 5126]);
const INDEX_COMPONENT_TYPES = new Set([5121, 5123, 5125]);
const INDEX_MAX: Record<number, number> = { 5121: 0xff, 5123: 0xffff, 5125: 0xffffffff };
const COMPONENT_NAMES: Record<number, string> = {
  5120: 'BYTE',
  5121: 'UNSIGNED_BYTE',
  5122: 'SHORT',
  5123: 'UNSIGNED_SHORT',
  5125: 'UNSIGNED_INT',
  5126: 'FLOAT',
};
const COMPRESSION_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'];
const ANIMATION_PATHS = new Set(['translation', 'rotation', 'scale', 'weights']);

class Checker {
  readonly issues: Issue[] = [];

  constructor(
    readonly asset: Asset,
    readonly root: Obj,
  ) {}

  add(severity: Severity, code: IssueCode, path: Path, message: string): void {
    this.issues.push({ severity, code, path: pointer(path), location: dotted(path), message });
  }

  error(code: IssueCode, path: Path, message: string): void {
    this.add('error', code, path, message);
  }

  warn(code: IssueCode, path: Path, message: string): void {
    this.add('warning', code, path, message);
  }

  private readonly lists = new Map<string, unknown[]>();

  /** The array stored under `key`, or an empty one. Reports a wrong type once. */
  list(key: string): unknown[] {
    const cached = this.lists.get(key);
    if (cached !== undefined) return cached;
    const value = this.root[key];
    let result: unknown[] = [];
    if (Array.isArray(value)) {
      result = value as unknown[];
    } else if (value !== undefined) {
      this.error('TYPE_MISMATCH', [key], `"${key}" must be an array but is ${describeType(value)}.`);
    }
    this.lists.set(key, result);
    return result;
  }

  /**
   * Checks that `value` is a valid index into a top-level array of `size` entries.
   * Returns the index when it is, otherwise reports and returns undefined.
   */
  ref(path: Path, value: unknown, collection: string, size: number, owner = 'the asset'): number | undefined {
    if (!isInt(value) || value < 0) {
      this.error('TYPE_MISMATCH', path, `must be a non-negative integer index into ${collection}, found ${JSON.stringify(value)}.`);
      return undefined;
    }
    if (value >= size) {
      this.error('INDEX_OUT_OF_RANGE', path, `${collection}[${value}] does not exist; ${owner} has ${plural(size, collection)}.`);
      return undefined;
    }
    return value;
  }

  /** Checks an optional non-negative integer field. */
  optionalInt(obj: Obj, key: string, path: Path, min = 0): number | undefined {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (!isInt(value) || value < min) {
      this.error('TYPE_MISMATCH', [...path, key], `must be an integer of at least ${min}, found ${JSON.stringify(value)}.`);
      return undefined;
    }
    return value;
  }

  /** Checks an optional array of numbers of an exact length. */
  numberArray(obj: Obj, key: string, path: Path, length: number): number[] | undefined {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length !== length || !value.every(isNum)) {
      this.error('TYPE_MISMATCH', [...path, key], `must be an array of ${length} numbers, found ${JSON.stringify(value)}.`);
      return undefined;
    }
    return value;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function checkAssetInfo(c: Checker): void {
  const info = c.root.asset;
  if (!isObj(info)) {
    c.error('ASSET_VERSION', ['asset'], 'The required "asset" object is missing. Every glTF file needs asset.version.');
    return;
  }
  if (typeof info.version !== 'string') {
    c.error('ASSET_VERSION', ['asset', 'version'], 'The required "asset.version" is missing or not a string. glTF 2.0 files use "2.0".');
    return;
  }
  const major = Number.parseInt(info.version.split('.')[0] ?? '', 10);
  if (major !== 2) {
    c.error('ASSET_VERSION', ['asset', 'version'], `asset.version is "${info.version}", but gltf-forge reads glTF 2.x only.`);
  }
  if (typeof info.minVersion === 'string' && Number.parseFloat(info.minVersion) > 2) {
    c.error('ASSET_VERSION', ['asset', 'minVersion'], `asset.minVersion "${info.minVersion}" is newer than 2.0, so this file needs features gltf-forge does not know.`);
  }
}

/** Returns true when data-level checks should run. Compressed geometry cannot be read, so they are skipped. */
function checkExtensions(c: Checker): boolean {
  const used = c.root.extensionsUsed;
  const required = c.root.extensionsRequired;
  for (const [key, value] of [['extensionsUsed', used], ['extensionsRequired', required]] as const) {
    if (value !== undefined && (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))) {
      c.error('TYPE_MISMATCH', [key], `"${key}" must be an array of extension names.`);
    }
  }
  const usedList = Array.isArray(used) ? (used as unknown[]) : [];
  if (Array.isArray(required)) {
    required.forEach((name: unknown, i) => {
      if (typeof name === 'string' && !usedList.includes(name)) {
        c.error('EXTENSION_NOT_USED', ['extensionsRequired', i], `"${name}" is listed in extensionsRequired but not in extensionsUsed. Every required extension must also be listed as used.`);
      }
    });
  }
  const compressed = COMPRESSION_EXTENSIONS.filter((name) => usedList.includes(name));
  if (compressed.length > 0) {
    c.warn(
      'EXTENSION_UNSUPPORTED',
      ['extensionsUsed'],
      `The asset uses ${compressed.join(' and ')}. gltf-forge cannot decode compressed geometry yet, so index ranges and min/max values were not checked against the data.`,
    );
    return false;
  }
  return true;
}

function checkBuffers(c: Checker): void {
  const buffers = c.list('buffers');
  const hasBin = c.asset.chunks?.some((chunk) => chunk.type === CHUNK_BIN) ?? false;
  buffers.forEach((raw, i) => {
    const path: Path = ['buffers', i];
    if (!isObj(raw)) {
      c.error('TYPE_MISMATCH', path, `must be an object but is ${describeType(raw)}.`);
      return;
    }
    const declared = raw.byteLength;
    if (!isInt(declared) || declared < 1) {
      c.error('TYPE_MISMATCH', [...path, 'byteLength'], `is required and must be an integer of at least 1, found ${JSON.stringify(declared)}.`);
      return;
    }
    const data = c.asset.buffers[i] ?? null;
    if (raw.uri === undefined) {
      if (c.asset.format === 'glb' && i === 0) {
        if (!hasBin) {
          c.error('BUFFER_NO_DATA', path, 'buffers[0] has no uri, which means it uses the GLB BIN chunk, but the file has no BIN chunk.');
        } else if (data !== null) {
          if (declared > data.byteLength) {
            c.error('BUFFER_TOO_SHORT', [...path, 'byteLength'], `buffers[0] declares ${declared} bytes but the GLB BIN chunk only holds ${data.byteLength}.`);
          } else if (data.byteLength - declared > 3) {
            c.warn('BUFFER_PADDING', [...path, 'byteLength'], `The GLB BIN chunk holds ${data.byteLength} bytes but buffers[0] declares ${declared}. The spec allows at most 3 bytes of chunk padding.`);
          }
        }
      } else {
        c.error('BUFFER_URI', path, `buffers[${i}] has no uri. Only the first buffer of a GLB may omit it, and it then uses the BIN chunk.`);
      }
      return;
    }
    if (typeof raw.uri !== 'string') {
      c.error('TYPE_MISMATCH', [...path, 'uri'], `must be a string, found ${JSON.stringify(raw.uri)}.`);
      return;
    }
    let kind: ReturnType<typeof classifyUri>;
    try {
      kind = classifyUri(raw.uri);
    } catch (error) {
      c.error('BUFFER_URI', [...path, 'uri'], error instanceof GltfError ? error.message : String(error));
      return;
    }
    if (kind === 'remote') {
      c.warn('BUFFER_REMOTE', [...path, 'uri'], `buffers[${i}] lives at a remote URL. gltf-forge does no network access, so its data was not loaded or checked.`);
    } else if (data !== null && declared > data.byteLength) {
      c.error('BUFFER_TOO_SHORT', [...path, 'byteLength'], `buffers[${i}] declares ${declared} bytes but its data only has ${data.byteLength}.`);
    }
  });
}

function checkBufferViews(c: Checker): void {
  const buffers = c.list('buffers');
  c.list('bufferViews').forEach((raw, i) => {
    const path: Path = ['bufferViews', i];
    if (!isObj(raw)) {
      c.error('TYPE_MISMATCH', path, `must be an object but is ${describeType(raw)}.`);
      return;
    }
    const buffer = c.ref([...path, 'buffer'], raw.buffer, 'buffers', buffers.length);
    const length = raw.byteLength;
    if (!isInt(length) || length < 1) {
      c.error('TYPE_MISMATCH', [...path, 'byteLength'], `is required and must be an integer of at least 1, found ${JSON.stringify(length)}.`);
      return;
    }
    const offset = c.optionalInt(raw, 'byteOffset', path) ?? 0;
    if (buffer !== undefined) {
      const owner = buffers[buffer];
      const total = isObj(owner) && isInt(owner.byteLength) ? owner.byteLength : undefined;
      if (total !== undefined && offset + length > total) {
        c.error('BUFFER_VIEW_RANGE', path, `bufferViews[${i}] covers bytes ${offset} to ${offset + length} but buffers[${buffer}] is only ${total} bytes long.`);
      }
    }
    const stride = c.optionalInt(raw, 'byteStride', path);
    if (stride !== undefined && (stride < 4 || stride > 252 || stride % 4 !== 0)) {
      c.error('BUFFER_VIEW_STRIDE', [...path, 'byteStride'], `byteStride is ${stride}. It must be a multiple of 4 between 4 and 252.`);
    }
    if (raw.target !== undefined && raw.target !== 34962 && raw.target !== 34963) {
      c.error('TYPE_MISMATCH', [...path, 'target'], `must be 34962 (ARRAY_BUFFER) or 34963 (ELEMENT_ARRAY_BUFFER), found ${JSON.stringify(raw.target)}.`);
    }
  });
}

/** Returns the set of accessor indices whose structure is sound enough to read data from. */
function checkAccessors(c: Checker): Set<number> {
  const views = c.list('bufferViews');
  const sound = new Set<number>();
  c.list('accessors').forEach((raw, i) => {
    const path: Path = ['accessors', i];
    if (!isObj(raw)) {
      c.error('TYPE_MISMATCH', path, `must be an object but is ${describeType(raw)}.`);
      return;
    }
    let ok = true;
    const fail = (code: IssueCode, where: Path, message: string): void => {
      ok = false;
      c.error(code, where, message);
    };

    const componentType = raw.componentType;
    if (typeof componentType !== 'number' || !VALID_COMPONENT_TYPES.has(componentType)) {
      fail('ACCESSOR_ENUM', [...path, 'componentType'], `componentType must be one of 5120, 5121, 5122, 5123, 5125 or 5126, found ${JSON.stringify(componentType)}.`);
    }
    const type = raw.type;
    if (typeof type !== 'string' || !(type in TYPE_COMPONENTS)) {
      fail('ACCESSOR_ENUM', [...path, 'type'], `type must be SCALAR, VEC2, VEC3, VEC4, MAT2, MAT3 or MAT4, found ${JSON.stringify(type)}.`);
    }
    const count = raw.count;
    if (!isInt(count) || count < 1) {
      fail('TYPE_MISMATCH', [...path, 'count'], `is required and must be an integer of at least 1, found ${JSON.stringify(count)}.`);
    }
    if (raw.normalized === true && (componentType === 5126 || componentType === 5125)) {
      fail('ACCESSOR_ENUM', [...path, 'normalized'], `normalized cannot be used with ${COMPONENT_NAMES[componentType] ?? ''} data.`);
    }
    if (!ok) return;

    const elementBytes = elementByteSize(type as keyof typeof TYPE_COMPONENTS, componentType as number);
    const componentBytes = COMPONENT_BYTES[componentType as number];
    if (elementBytes === undefined || componentBytes === undefined) return;

    // min and max
    const components = TYPE_COMPONENTS[type as keyof typeof TYPE_COMPONENTS];
    for (const key of ['min', 'max'] as const) {
      const bound = raw[key];
      if (bound === undefined) continue;
      if (!Array.isArray(bound) || bound.length !== components || !bound.every(isNum)) {
        fail('ACCESSOR_MINMAX', [...path, key], `${key} must be an array of ${components} numbers to match type ${String(type)}, found ${JSON.stringify(bound)}.`);
      }
    }
    if (Array.isArray(raw.min) && Array.isArray(raw.max) && ok) {
      const lo = raw.min as number[];
      const hi = raw.max as number[];
      if (lo.some((v, k) => v > (hi[k] ?? Infinity))) {
        fail('ACCESSOR_MINMAX', path, 'min has a component larger than the matching component of max.');
      }
    }

    if (raw.sparse !== undefined) {
      c.warn('ACCESSOR_SPARSE_SKIPPED', [...path, 'sparse'], `accessors[${i}] is sparse. gltf-forge does not read sparse accessors yet, so its data was not checked.`);
      if (isObj(raw.sparse)) {
        const sparse = raw.sparse;
        const indices = isObj(sparse.indices) ? sparse.indices : {};
        const values = isObj(sparse.values) ? sparse.values : {};
        c.ref([...path, 'sparse', 'indices', 'bufferView'], indices.bufferView, 'bufferViews', views.length);
        c.ref([...path, 'sparse', 'values', 'bufferView'], values.bufferView, 'bufferViews', views.length);
      }
      ok = false;
    }

    const byteOffset = c.optionalInt(raw, 'byteOffset', path);
    if (raw.bufferView === undefined) {
      if (byteOffset !== undefined) {
        fail('ACCESSOR_RANGE', [...path, 'byteOffset'], 'byteOffset is set but the accessor has no bufferView.');
      }
      if (ok) sound.add(i);
      return;
    }
    const viewIndex = c.ref([...path, 'bufferView'], raw.bufferView, 'bufferViews', views.length);
    const view = viewIndex === undefined ? undefined : views[viewIndex];
    if (viewIndex === undefined || !isObj(view) || !isInt(view.byteLength)) return;
    const viewOffset = isInt(view.byteOffset) ? view.byteOffset : 0;
    const offset = byteOffset ?? 0;
    if (offset % componentBytes !== 0 || (viewOffset + offset) % componentBytes !== 0) {
      fail(
        'ACCESSOR_ALIGNMENT',
        [...path, 'byteOffset'],
        `The accessor starts at byte ${viewOffset + offset} of its buffer, which is not a multiple of its ${componentBytes}-byte components. Both accessor.byteOffset and the bufferView offset plus it must be aligned.`,
      );
    }
    const viewStride = isInt(view.byteStride) ? view.byteStride : undefined;
    if (viewStride !== undefined && viewStride < elementBytes) {
      fail('ACCESSOR_STRIDE', path, `Each element is ${elementBytes} bytes, but bufferViews[${viewIndex}].byteStride is only ${viewStride}, so elements would overlap.`);
    }
    const stride = viewStride ?? elementBytes;
    const needed = offset + stride * ((raw.count as number) - 1) + elementBytes;
    if (needed > view.byteLength) {
      fail('ACCESSOR_RANGE', path, `accessors[${i}] needs ${needed} bytes (${raw.count as number} elements of ${elementBytes} bytes, stride ${stride}) but bufferViews[${viewIndex}] is only ${view.byteLength} bytes long.`);
    }
    if (ok) sound.add(i);
  });
  return sound;
}

function checkImagesAndTextures(c: Checker): void {
  const views = c.list('bufferViews');
  const images = c.list('images');
  images.forEach((raw, i) => {
    const path: Path = ['images', i];
    if (!isObj(raw)) {
      c.error('TYPE_MISMATCH', path, `must be an object but is ${describeType(raw)}.`);
      return;
    }
    const hasUri = raw.uri !== undefined;
    const hasView = raw.bufferView !== undefined;
    if (hasUri === hasView) {
      c.error('IMAGE_SOURCE', path, hasUri ? `images[${i}] has both a uri and a bufferView. It must have exactly one.` : `images[${i}] has neither a uri nor a bufferView. It must have exactly one.`);
      return;
    }
    if (hasView) {
      c.ref([...path, 'bufferView'], raw.bufferView, 'bufferViews', views.length);
      if (typeof raw.mimeType !== 'string') {
        c.error('IMAGE_MIME', [...path, 'mimeType'], `images[${i}] is stored in a bufferView, so mimeType is required (for example "image/png").`);
      }
    }
    if (typeof raw.mimeType === 'string' && !['image/png', 'image/jpeg', 'image/ktx2', 'image/webp'].includes(raw.mimeType)) {
      c.warn('IMAGE_MIME', [...path, 'mimeType'], `images[${i}] has mimeType "${raw.mimeType}". The core spec allows only image/jpeg and image/png; others need an extension.`);
    }
    let bytes: Uint8Array | null;
    try {
      if (typeof raw.uri === 'string') {
        const kind = classifyUri(raw.uri);
        if (kind === 'data') decodeDataUri(raw.uri);
        else if (kind === 'remote') return;
      }
      bytes = getImageBytes(c.asset, i);
    } catch (error) {
      c.error('IMAGE_UNREADABLE', [...path, 'uri'], error instanceof GltfError ? error.message : String(error));
      return;
    }
    if (bytes === null) return;
    const info = readImageInfo(bytes);
    if (info === null) {
      c.warn('IMAGE_UNREADABLE', path, `images[${i}] is not a PNG, JPEG or KTX2 file gltf-forge can read, or its header is damaged, so its size is unknown.`);
    } else if (typeof raw.mimeType === 'string') {
      const expected = { png: 'image/png', jpeg: 'image/jpeg', ktx2: 'image/ktx2' }[info.format];
      if (raw.mimeType !== expected) {
        c.warn('IMAGE_MIME', [...path, 'mimeType'], `images[${i}] declares ${raw.mimeType} but the bytes are ${expected}.`);
      }
    }
  });

  const samplers = c.list('samplers');
  const filters = [9728, 9729];
  const minFilters = [9728, 9729, 9984, 9985, 9986, 9987];
  const wraps = [33071, 33648, 10497];
  samplers.forEach((raw, i) => {
    if (!isObj(raw)) {
      c.error('TYPE_MISMATCH', ['samplers', i], `must be an object but is ${describeType(raw)}.`);
      return;
    }
    const check = (key: string, allowed: number[]): void => {
      const value = raw[key];
      if (value !== undefined && (typeof value !== 'number' || !allowed.includes(value))) {
        c.error('SAMPLER_ENUM', ['samplers', i, key], `${key} must be one of ${allowed.join(', ')}, found ${JSON.stringify(value)}.`);
      }
    };
    check('magFilter', filters);
    check('minFilter', minFilters);
    check('wrapS', wraps);
    check('wrapT', wraps);
  });

  c.list('textures').forEach((raw, i) => {
    if (!isObj(raw)) {
      c.error('TYPE_MISMATCH', ['textures', i], `must be an object but is ${describeType(raw)}.`);
      return;
    }
    if (raw.source !== undefined) c.ref(['textures', i, 'source'], raw.source, 'images', images.length);
    if (raw.sampler !== undefined) c.ref(['textures', i, 'sampler'], raw.sampler, 'samplers', samplers.length);
  });
}

function checkMaterials(c: Checker): void {
  const textureCount = c.list('textures').length;
  const textureInfo = (value: unknown, path: Path): void => {
    if (value === undefined) return;
    if (!isObj(value)) {
      c.error('TYPE_MISMATCH', path, `must be an object but is ${describeType(value)}.`);
      return;
    }
    c.ref([...path, 'index'], value.index, 'textures', textureCount);
  };
  const unit = (value: unknown, path: Path): void => {
    if (value !== undefined && (!isNum(value) || value < 0 || value > 1)) {
      c.error('MATERIAL_VALUE', path, `must be a number between 0 and 1, found ${JSON.stringify(value)}.`);
    }
  };
  c.list('materials').forEach((raw, i) => {
    const path: Path = ['materials', i];
    if (!isObj(raw)) {
      c.error('TYPE_MISMATCH', path, `must be an object but is ${describeType(raw)}.`);
      return;
    }
    textureInfo(raw.normalTexture, [...path, 'normalTexture']);
    textureInfo(raw.occlusionTexture, [...path, 'occlusionTexture']);
    textureInfo(raw.emissiveTexture, [...path, 'emissiveTexture']);
    if (raw.pbrMetallicRoughness !== undefined) {
      const pbr = raw.pbrMetallicRoughness;
      if (!isObj(pbr)) {
        c.error('TYPE_MISMATCH', [...path, 'pbrMetallicRoughness'], `must be an object but is ${describeType(pbr)}.`);
      } else {
        const base: Path = [...path, 'pbrMetallicRoughness'];
        textureInfo(pbr.baseColorTexture, [...base, 'baseColorTexture']);
        textureInfo(pbr.metallicRoughnessTexture, [...base, 'metallicRoughnessTexture']);
        unit(pbr.metallicFactor, [...base, 'metallicFactor']);
        unit(pbr.roughnessFactor, [...base, 'roughnessFactor']);
        const color = c.numberArray(pbr, 'baseColorFactor', base, 4);
        if (color?.some((v) => v < 0 || v > 1)) {
          c.error('MATERIAL_VALUE', [...base, 'baseColorFactor'], 'baseColorFactor components must be between 0 and 1.');
        }
      }
    }
    if (raw.alphaMode !== undefined && raw.alphaMode !== 'OPAQUE' && raw.alphaMode !== 'MASK' && raw.alphaMode !== 'BLEND') {
      c.error('MATERIAL_VALUE', [...path, 'alphaMode'], `must be "OPAQUE", "MASK" or "BLEND", found ${JSON.stringify(raw.alphaMode)}.`);
    }
    if (raw.alphaCutoff !== undefined && (!isNum(raw.alphaCutoff) || raw.alphaCutoff < 0)) {
      c.error('MATERIAL_VALUE', [...path, 'alphaCutoff'], `must be a number of at least 0, found ${JSON.stringify(raw.alphaCutoff)}.`);
    }
  });
}

function accessorSummary(c: Checker, index: number): { count: number; type: unknown; componentType: unknown } | undefined {
  const accessor = c.list('accessors')[index];
  if (!isObj(accessor)) return undefined;
  return { count: accessor.count as number, type: accessor.type, componentType: accessor.componentType };
}

function checkMeshes(c: Checker, sound: ReadonlySet<number>, checkData: boolean): void {
  const accessorCount = c.list('accessors').length;
  const materialCount = c.list('materials').length;
  const quantized = Array.isArray(c.root.extensionsUsed) && (c.root.extensionsUsed as unknown[]).includes('KHR_mesh_quantization');
  const positionAccessors = new Set<number>();
  const cache = new Map<number, AccessorData | null>();
  const data = (index: number): AccessorData | null => {
    if (!cache.has(index)) {
      let result: AccessorData | null;
      try {
        result = readAccessor(c.asset, index);
      } catch {
        result = null;
      }
      cache.set(index, result);
    }
    return cache.get(index) ?? null;
  };

  c.list('meshes').forEach((rawMesh, m) => {
    const meshPath: Path = ['meshes', m];
    if (!isObj(rawMesh)) {
      c.error('TYPE_MISMATCH', meshPath, `must be an object but is ${describeType(rawMesh)}.`);
      return;
    }
    const primitives = rawMesh.primitives;
    if (!Array.isArray(primitives) || primitives.length === 0) {
      c.error('PRIMITIVE_ATTRIBUTES', [...meshPath, 'primitives'], `meshes[${m}] needs a non-empty "primitives" array.`);
      return;
    }
    (primitives as unknown[]).forEach((rawPrim, p) => {
      const path: Path = [...meshPath, 'primitives', p];
      if (!isObj(rawPrim)) {
        c.error('TYPE_MISMATCH', path, `must be an object but is ${describeType(rawPrim)}.`);
        return;
      }
      const label = `meshes[${m}].primitives[${p}]`;
      const mode = rawPrim.mode === undefined ? 4 : rawPrim.mode;
      if (!isInt(mode) || mode < 0 || mode > 6) {
        c.error('PRIMITIVE_MODE', [...path, 'mode'], `mode must be an integer from 0 to 6, found ${JSON.stringify(mode)}.`);
      }
      if (rawPrim.material !== undefined) c.ref([...path, 'material'], rawPrim.material, 'materials', materialCount);

      const attributes = rawPrim.attributes;
      if (!isObj(attributes) || Object.keys(attributes).length === 0) {
        if (rawPrim.extensions === undefined) {
          c.error('PRIMITIVE_ATTRIBUTES', [...path, 'attributes'], `${label} needs an "attributes" object with at least one entry.`);
        }
        return;
      }
      let vertexCount: number | undefined;
      let countsAgree = true;
      for (const [name, value] of Object.entries(attributes)) {
        const attrPath: Path = [...path, 'attributes', name];
        const index = c.ref(attrPath, value, 'accessors', accessorCount);
        if (index === undefined) continue;
        const summary = accessorSummary(c, index);
        if (summary === undefined || !isInt(summary.count)) continue;
        if (vertexCount === undefined) vertexCount = summary.count;
        else if (vertexCount !== summary.count) {
          countsAgree = false;
          c.error('PRIMITIVE_COUNT', attrPath, `${label} attribute ${name} has ${summary.count} elements but earlier attributes have ${vertexCount}. All attributes of a primitive must have the same count.`);
        }
        if (name === 'POSITION') {
          positionAccessors.add(index);
          if (!quantized && (summary.type !== 'VEC3' || summary.componentType !== 5126)) {
            c.error('PRIMITIVE_ATTRIBUTES', attrPath, `${label} POSITION must be VEC3 of FLOAT, but accessors[${index}] is ${String(summary.type)} of ${COMPONENT_NAMES[summary.componentType as number] ?? String(summary.componentType)}.`);
          }
        }
      }
      if (attributes.POSITION === undefined && rawPrim.extensions === undefined) {
        c.warn('PRIMITIVE_ATTRIBUTES', [...path, 'attributes'], `${label} has no POSITION attribute, so there is nothing to draw.`);
      }

      let drawCount = vertexCount;
      if (rawPrim.indices !== undefined) {
        const indexAccessor = c.ref([...path, 'indices'], rawPrim.indices, 'accessors', accessorCount);
        if (indexAccessor !== undefined) {
          const summary = accessorSummary(c, indexAccessor);
          if (summary !== undefined) {
            if (summary.type !== 'SCALAR' || typeof summary.componentType !== 'number' || !INDEX_COMPONENT_TYPES.has(summary.componentType)) {
              c.error('PRIMITIVE_INDICES', [...path, 'indices'], `${label} indices must be SCALAR of UNSIGNED_BYTE, UNSIGNED_SHORT or UNSIGNED_INT, but accessors[${indexAccessor}] is ${String(summary.type)} of ${COMPONENT_NAMES[summary.componentType as number] ?? String(summary.componentType)}.`);
            } else if (isInt(summary.count)) {
              drawCount = summary.count;
              if (checkData && countsAgree && vertexCount !== undefined && sound.has(indexAccessor)) {
                const values = data(indexAccessor);
                if (values !== null) {
                  const restart = INDEX_MAX[summary.componentType];
                  let max = -1;
                  let restartAt = -1;
                  for (let k = 0; k < values.values.length; k++) {
                    const v = values.values[k] ?? 0;
                    if (v > max) max = v;
                    if (v === restart && restartAt < 0) restartAt = k;
                  }
                  if (restartAt >= 0) {
                    c.error('PRIMITIVE_INDEX_RANGE', [...path, 'indices'], `${label} index ${restartAt} holds ${restart}, the primitive restart value, which glTF does not allow.`);
                  } else if (max >= vertexCount) {
                    c.error('PRIMITIVE_INDEX_RANGE', [...path, 'indices'], `${label} has an index of ${max}, but the primitive only has ${vertexCount} vertices (valid indices are 0 to ${vertexCount - 1}).`);
                  }
                }
              }
            }
          }
        }
      }

      if (drawCount !== undefined && isInt(mode)) {
        const need = { 0: 1, 1: 2, 2: 2, 3: 2, 4: 3, 5: 3, 6: 3 }[mode];
        const what = rawPrim.indices !== undefined ? 'indices' : 'vertices';
        if (need !== undefined && drawCount < need) {
          c.error('PRIMITIVE_COUNT', path, `${label} draws ${drawCount} ${what}, but mode ${mode} needs at least ${need}.`);
        } else if ((mode === 4 && drawCount % 3 !== 0) || (mode === 1 && drawCount % 2 !== 0)) {
          c.error('PRIMITIVE_COUNT', path, `${label} draws ${drawCount} ${what}, which is not a multiple of ${mode === 4 ? 3 : 2}, so the last ${mode === 4 ? 'triangle' : 'line'} is incomplete.`);
        }
      }

      if (rawPrim.targets !== undefined) {
        if (!Array.isArray(rawPrim.targets)) {
          c.error('TYPE_MISMATCH', [...path, 'targets'], 'must be an array of attribute maps.');
        } else {
          (rawPrim.targets as unknown[]).forEach((target, t) => {
            if (!isObj(target)) {
              c.error('TYPE_MISMATCH', [...path, 'targets', t], `must be an object but is ${describeType(target)}.`);
              return;
            }
            for (const [name, value] of Object.entries(target)) {
              c.ref([...path, 'targets', t, name], value, 'accessors', accessorCount);
            }
          });
        }
      }
    });
  });

  if (!checkData) return;
  for (const index of positionAccessors) {
    const raw = c.list('accessors')[index];
    if (!isObj(raw)) continue;
    if (raw.min === undefined || raw.max === undefined) {
      c.error('ACCESSOR_MINMAX', ['accessors', index], `accessors[${index}] is used as POSITION, so min and max are required. Viewers use them to compute bounding boxes.`);
      continue;
    }
    if (!sound.has(index) || !Array.isArray(raw.min) || !Array.isArray(raw.max)) continue;
    const values = data(index);
    if (values === null || values.count === 0) continue;
    const lo = new Array<number>(values.componentCount).fill(Infinity);
    const hi = new Array<number>(values.componentCount).fill(-Infinity);
    for (let i = 0; i < values.count; i++) {
      for (let k = 0; k < values.componentCount; k++) {
        const v = values.values[i * values.componentCount + k] ?? 0;
        if (v < (lo[k] ?? Infinity)) lo[k] = v;
        if (v > (hi[k] ?? -Infinity)) hi[k] = v;
      }
    }
    const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
    const declaredMin = raw.min as number[];
    const declaredMax = raw.max as number[];
    const bad = lo.findIndex((v, k) => !close(v, declaredMin[k] ?? NaN) || !close(hi[k] ?? NaN, declaredMax[k] ?? NaN));
    if (bad >= 0) {
      c.error(
        'ACCESSOR_MINMAX',
        ['accessors', index],
        `accessors[${index}] declares min ${JSON.stringify(declaredMin)} and max ${JSON.stringify(declaredMax)}, but the data actually spans ${JSON.stringify(lo)} to ${JSON.stringify(hi)}.`,
      );
    }
  }
}

function checkScene(c: Checker): void {
  const nodes = c.list('nodes');
  const meshCount = c.list('meshes').length;
  const skinCount = c.list('skins').length;
  const cameraCount = c.list('cameras').length;
  const parents = new Map<number, number>();
  const children = new Map<number, number[]>();

  nodes.forEach((raw, i) => {
    const path: Path = ['nodes', i];
    if (!isObj(raw)) {
      c.error('TYPE_MISMATCH', path, `must be an object but is ${describeType(raw)}.`);
      return;
    }
    if (raw.mesh !== undefined) c.ref([...path, 'mesh'], raw.mesh, 'meshes', meshCount);
    if (raw.skin !== undefined) c.ref([...path, 'skin'], raw.skin, 'skins', skinCount);
    if (raw.camera !== undefined) c.ref([...path, 'camera'], raw.camera, 'cameras', cameraCount);

    const matrix = c.numberArray(raw, 'matrix', path, 16);
    const translation = c.numberArray(raw, 'translation', path, 3);
    const rotation = c.numberArray(raw, 'rotation', path, 4);
    const scale = c.numberArray(raw, 'scale', path, 3);
    if (matrix !== undefined && (translation !== undefined || rotation !== undefined || scale !== undefined)) {
      c.error('NODE_TRANSFORM', path, `nodes[${i}] has both a matrix and translation, rotation or scale. A node may use one or the other.`);
    }
    if (rotation !== undefined) {
      const length = Math.hypot(...rotation);
      if (Math.abs(length - 1) > 1e-3) {
        c.warn('NODE_TRANSFORM', [...path, 'rotation'], `nodes[${i}] rotation is a quaternion of length ${length.toFixed(4)}. It should be normalized to length 1.`);
      }
    }

    if (raw.children !== undefined) {
      if (!Array.isArray(raw.children)) {
        c.error('TYPE_MISMATCH', [...path, 'children'], 'must be an array of node indices.');
        return;
      }
      const valid: number[] = [];
      (raw.children as unknown[]).forEach((child, k) => {
        const index = c.ref([...path, 'children', k], child, 'nodes', nodes.length);
        if (index === undefined) return;
        valid.push(index);
        const parent = parents.get(index);
        if (parent !== undefined && parent !== i) {
          c.error('NODE_PARENT', [...path, 'children', k], `nodes[${index}] is a child of both nodes[${parent}] and nodes[${i}]. A node can have only one parent.`);
        }
        parents.set(index, i);
      });
      children.set(i, valid);
    }
  });

  // Cycle check, iterative so a very deep hierarchy cannot overflow the call stack.
  const state = new Map<number, 1 | 2>();
  for (let start = 0; start < nodes.length; start++) {
    if (state.has(start)) continue;
    const stack: { node: number; next: number }[] = [{ node: start, next: 0 }];
    state.set(start, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      const kids = children.get(top.node) ?? [];
      const child = kids[top.next++];
      if (child === undefined) {
        state.set(top.node, 2);
        stack.pop();
      } else if (state.get(child) === 1) {
        c.error('NODE_CYCLE', ['nodes', top.node, 'children'], `nodes[${top.node}] has nodes[${child}] as a child, but nodes[${child}] is already one of its ancestors. The node hierarchy must not contain cycles.`);
      } else if (!state.has(child)) {
        state.set(child, 1);
        stack.push({ node: child, next: 0 });
      }
    }
  }

  const scenes = c.list('scenes');
  scenes.forEach((raw, i) => {
    const path: Path = ['scenes', i];
    if (!isObj(raw)) {
      c.error('TYPE_MISMATCH', path, `must be an object but is ${describeType(raw)}.`);
      return;
    }
    if (raw.nodes === undefined) return;
    if (!Array.isArray(raw.nodes)) {
      c.error('TYPE_MISMATCH', [...path, 'nodes'], 'must be an array of node indices.');
      return;
    }
    (raw.nodes as unknown[]).forEach((node, k) => {
      const index = c.ref([...path, 'nodes', k], node, 'nodes', nodes.length);
      if (index !== undefined && parents.has(index)) {
        c.error('NODE_PARENT', [...path, 'nodes', k], `scenes[${i}] lists nodes[${index}] as a root, but it is a child of nodes[${parents.get(index) ?? 0}]. Scene roots must not have parents.`);
      }
    });
  });
  if (c.root.scene !== undefined) c.ref(['scene'], c.root.scene, 'scenes', scenes.length);
}

function checkSkinsAnimationsCameras(c: Checker): void {
  const nodeCount = c.list('nodes').length;
  const accessorCount = c.list('accessors').length;

  c.list('skins').forEach((raw, i) => {
    const path: Path = ['skins', i];
    if (!isObj(raw)) {
      c.error('TYPE_MISMATCH', path, `must be an object but is ${describeType(raw)}.`);
      return;
    }
    if (!Array.isArray(raw.joints) || raw.joints.length === 0) {
      c.error('TYPE_MISMATCH', [...path, 'joints'], `skins[${i}] needs a non-empty "joints" array of node indices.`);
    } else {
      (raw.joints as unknown[]).forEach((joint, k) => c.ref([...path, 'joints', k], joint, 'nodes', nodeCount));
    }
    if (raw.inverseBindMatrices !== undefined) c.ref([...path, 'inverseBindMatrices'], raw.inverseBindMatrices, 'accessors', accessorCount);
    if (raw.skeleton !== undefined) c.ref([...path, 'skeleton'], raw.skeleton, 'nodes', nodeCount);
  });

  const pointer = Array.isArray(c.root.extensionsUsed) && (c.root.extensionsUsed as unknown[]).includes('KHR_animation_pointer');
  c.list('animations').forEach((raw, i) => {
    const path: Path = ['animations', i];
    if (!isObj(raw)) {
      c.error('TYPE_MISMATCH', path, `must be an object but is ${describeType(raw)}.`);
      return;
    }
    const samplers = Array.isArray(raw.samplers) ? (raw.samplers as unknown[]) : [];
    if (!Array.isArray(raw.samplers) || samplers.length === 0) c.error('ANIMATION', [...path, 'samplers'], `animations[${i}] needs a non-empty "samplers" array.`);
    samplers.forEach((sampler, s) => {
      if (!isObj(sampler)) {
        c.error('TYPE_MISMATCH', [...path, 'samplers', s], `must be an object but is ${describeType(sampler)}.`);
        return;
      }
      c.ref([...path, 'samplers', s, 'input'], sampler.input, 'accessors', accessorCount);
      c.ref([...path, 'samplers', s, 'output'], sampler.output, 'accessors', accessorCount);
      if (sampler.interpolation !== undefined && (typeof sampler.interpolation !== 'string' || !['LINEAR', 'STEP', 'CUBICSPLINE'].includes(sampler.interpolation))) {
        c.error('ANIMATION', [...path, 'samplers', s, 'interpolation'], `must be LINEAR, STEP or CUBICSPLINE, found ${JSON.stringify(sampler.interpolation)}.`);
      }
    });
    if (!Array.isArray(raw.channels) || raw.channels.length === 0) {
      c.error('ANIMATION', [...path, 'channels'], `animations[${i}] needs a non-empty "channels" array.`);
      return;
    }
    (raw.channels as unknown[]).forEach((channel, k) => {
      const cp: Path = [...path, 'channels', k];
      if (!isObj(channel)) {
        c.error('TYPE_MISMATCH', cp, `must be an object but is ${describeType(channel)}.`);
        return;
      }
      c.ref([...cp, 'sampler'], channel.sampler, 'samplers', samplers.length, `animations[${i}]`);
      const target = channel.target;
      if (!isObj(target)) {
        c.error('TYPE_MISMATCH', [...cp, 'target'], 'is required and must be an object.');
        return;
      }
      if (target.node !== undefined) c.ref([...cp, 'target', 'node'], target.node, 'nodes', nodeCount);
      if (typeof target.path !== 'string' || (!ANIMATION_PATHS.has(target.path) && !(pointer && target.path === 'pointer'))) {
        c.error('ANIMATION', [...cp, 'target', 'path'], `must be translation, rotation, scale or weights, found ${JSON.stringify(target.path)}.`);
      }
    });
  });

  c.list('cameras').forEach((raw, i) => {
    const path: Path = ['cameras', i];
    if (!isObj(raw)) {
      c.error('TYPE_MISMATCH', path, `must be an object but is ${describeType(raw)}.`);
      return;
    }
    if (raw.type !== 'perspective' && raw.type !== 'orthographic') {
      c.error('CAMERA', [...path, 'type'], `must be "perspective" or "orthographic", found ${JSON.stringify(raw.type)}.`);
    } else if (!isObj(raw[raw.type])) {
      c.error('CAMERA', [...path, raw.type], `cameras[${i}] has type "${raw.type}" so it needs a "${raw.type}" object.`);
    }
  });
}

/**
 * Checks an asset against the glTF 2.0 rules gltf-forge understands: structure,
 * index references, byte ranges, alignment, accessor data and the node hierarchy.
 * It never throws on a malformed asset; problems come back as issues.
 */
export function validate(asset: Asset): ValidationResult {
  const c = new Checker(asset, asset.json as unknown as Obj);
  checkAssetInfo(c);
  const checkData = checkExtensions(c);
  checkBuffers(c);
  checkBufferViews(c);
  const sound = checkAccessors(c);
  checkImagesAndTextures(c);
  checkMaterials(c);
  checkMeshes(c, sound, checkData);
  checkScene(c);
  checkSkinsAnimationsCameras(c);

  const errors = c.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = c.issues.length - errors;
  return { issues: c.issues, errors, warnings, ok: errors === 0 };
}
