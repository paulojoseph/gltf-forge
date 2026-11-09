import { GltfError } from './errors.js';

/** ASCII "glTF" read as a little-endian uint32. */
export const GLB_MAGIC = 0x46546c67;
/** ASCII "JSON" read as a little-endian uint32. */
export const CHUNK_JSON = 0x4e4f534a;
/** ASCII "BIN\0" read as a little-endian uint32. */
export const CHUNK_BIN = 0x004e4942;

const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

/**
 * One chunk of a GLB container. `data` is exactly the bytes in the file, padding
 * included, which is what lets an untouched file be written back identically.
 */
export interface GlbChunk {
  type: number;
  data: Uint8Array;
}

export function isGlb(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === GLB_MAGIC;
}

export function chunkTypeName(type: number): string {
  if (type === CHUNK_JSON) return 'JSON';
  if (type === CHUNK_BIN) return 'BIN';
  return `0x${type.toString(16).padStart(8, '0')}`;
}

/**
 * Splits a GLB file into its chunks. The returned chunk data are views into
 * `bytes`, not copies, so the input must not be modified afterwards.
 */
export function parseGlbChunks(bytes: Uint8Array): GlbChunk[] {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new GltfError(
      'GLB_HEADER',
      `Not a GLB file: it is ${bytes.byteLength} bytes long, but the GLB header alone takes ${HEADER_BYTES}.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    throw new GltfError(
      'GLB_HEADER',
      `Not a GLB file: expected the magic bytes "glTF" at the start but found 0x${magic.toString(16).padStart(8, '0')}.`,
    );
  }
  const version = view.getUint32(4, true);
  if (version !== 2) {
    throw new GltfError('GLB_VERSION', `Unsupported GLB container version ${version}. Only version 2 is supported.`);
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== bytes.byteLength) {
    throw new GltfError(
      'GLB_LENGTH',
      `The GLB header declares ${declaredLength} bytes but the file is ${bytes.byteLength} bytes long. The file is truncated or has data appended after the last chunk.`,
    );
  }

  const chunks: GlbChunk[] = [];
  let offset = HEADER_BYTES;
  while (offset < bytes.byteLength) {
    const index = chunks.length;
    if (bytes.byteLength - offset < CHUNK_HEADER_BYTES) {
      throw new GltfError(
        'GLB_CHUNK',
        `Chunk ${index} starts at byte ${offset} but only ${bytes.byteLength - offset} bytes remain, which is less than a chunk header (${CHUNK_HEADER_BYTES} bytes).`,
      );
    }
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + CHUNK_HEADER_BYTES;
    if (length % 4 !== 0) {
      throw new GltfError(
        'GLB_CHUNK',
        `Chunk ${index} (${chunkTypeName(type)}) is ${length} bytes long. The GLB spec requires chunk lengths to be multiples of 4.`,
      );
    }
    if (start + length > bytes.byteLength) {
      throw new GltfError(
        'GLB_CHUNK',
        `Chunk ${index} (${chunkTypeName(type)}) claims ${length} bytes but only ${bytes.byteLength - start} bytes remain in the file.`,
      );
    }
    chunks.push({ type, data: bytes.subarray(start, start + length) });
    offset = start + length;
  }

  const first = chunks[0];
  if (first === undefined) {
    throw new GltfError('GLB_CHUNK', 'The GLB file has no chunks. It must start with a JSON chunk.');
  }
  if (first.type !== CHUNK_JSON) {
    throw new GltfError(
      'GLB_CHUNK',
      `The first GLB chunk must be JSON but chunk 0 is ${chunkTypeName(first.type)}.`,
    );
  }
  const jsonCount = chunks.filter((c) => c.type === CHUNK_JSON).length;
  if (jsonCount > 1) {
    throw new GltfError('GLB_CHUNK', `The GLB file has ${jsonCount} JSON chunks. It must have exactly one.`);
  }
  const binCount = chunks.filter((c) => c.type === CHUNK_BIN).length;
  if (binCount > 1) {
    throw new GltfError('GLB_CHUNK', `The GLB file has ${binCount} BIN chunks. It may have at most one.`);
  }
  return chunks;
}

/** Packs chunks into a GLB file. Chunk data is written as given, so lengths must already be 4-byte aligned. */
export function serializeGlbChunks(chunks: readonly GlbChunk[]): Uint8Array {
  let total = HEADER_BYTES;
  for (const chunk of chunks) {
    if (chunk.data.byteLength % 4 !== 0) {
      throw new GltfError(
        'GLB_CHUNK',
        `Cannot write a ${chunkTypeName(chunk.type)} chunk of ${chunk.data.byteLength} bytes. Chunk lengths must be multiples of 4.`,
      );
    }
    total += CHUNK_HEADER_BYTES + chunk.data.byteLength;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let offset = HEADER_BYTES;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.data.byteLength, true);
    view.setUint32(offset + 4, chunk.type, true);
    out.set(chunk.data, offset + CHUNK_HEADER_BYTES);
    offset += CHUNK_HEADER_BYTES + chunk.data.byteLength;
  }
  return out;
}
