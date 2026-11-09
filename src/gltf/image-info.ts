import type { Asset } from './asset.js';
import { classifyUri, decodeDataUri } from './uri.js';

export interface ImageInfo {
  format: 'png' | 'jpeg' | 'ktx2';
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.byteLength >= prefix.length && prefix.every((value, i) => bytes[i] === value);
}

/**
 * Reads the pixel size from the header of a PNG, JPEG or KTX2 file without decoding
 * any pixels. Returns null for other formats and for truncated or corrupt headers.
 */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (startsWith(bytes, PNG_SIGNATURE)) {
    // Signature (8), chunk length (4), "IHDR" (4), then width and height as big-endian uint32.
    if (bytes.byteLength < 24 || view.getUint32(12) !== 0x49484452) return null;
    return { format: 'png', width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (startsWith(bytes, KTX2_IDENTIFIER)) {
    if (bytes.byteLength < 28) return null;
    return { format: 'ktx2', width: view.getUint32(20, true), height: view.getUint32(24, true) };
  }

  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.byteLength) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker === undefined) return null;
      if (marker === 0xff) {
        offset += 1; // fill byte
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2; // standalone marker, no length field
        continue;
      }
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        if (offset + 9 > bytes.byteLength) return null;
        return { format: 'jpeg', height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      if (marker === 0xda) return null; // start of scan reached without a frame header
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return null;
}

/**
 * The encoded bytes of `images[index]`, wherever they live. Returns null when they
 * cannot be reached (a remote URL, a missing file, a bufferView out of range).
 * Throws a GltfError if the image is a malformed data URI.
 */
export function getImageBytes(asset: Asset, index: number): Uint8Array | null {
  const image = asset.json.images?.[index];
  if (image === undefined) return null;
  if (typeof image.uri === 'string') {
    switch (classifyUri(image.uri)) {
      case 'data':
        return decodeDataUri(image.uri).bytes;
      case 'remote':
        return null;
      case 'relative':
        return asset.externalFiles.get(image.uri) ?? null;
    }
  }
  if (typeof image.bufferView === 'number') {
    const view = asset.json.bufferViews?.[image.bufferView];
    const buffer = view === undefined ? undefined : asset.buffers[view.buffer];
    if (view === undefined || buffer === undefined || buffer === null) return null;
    const start = view.byteOffset ?? 0;
    const end = start + view.byteLength;
    return end <= buffer.byteLength ? buffer.subarray(start, end) : null;
  }
  return null;
}
