import { GltfError } from './errors.js';
import {
  CHUNK_BIN,
  CHUNK_JSON,
  isGlb,
  parseGlbChunks,
  serializeGlbChunks,
  type GlbChunk,
} from './glb.js';
import type { GltfRoot } from './types.js';
import { classifyUri, decodeDataUri } from './uri.js';

/**
 * A loaded glTF or GLB file.
 *
 * `jsonBytes` and `chunks` hold the file exactly as it was read. Nothing in this
 * module re-encodes them unless you call `withJson`, which is how an untouched
 * asset writes back byte for byte.
 */
export interface Asset {
  format: 'gltf' | 'glb';
  json: GltfRoot;
  /** The JSON document exactly as stored (for GLB, the full JSON chunk including its padding). */
  jsonBytes: Uint8Array;
  /**
   * Bytes of each entry in `json.buffers`, by index. `null` when the data is not
   * available: a remote URL, or a buffer with no `uri` outside a GLB's first slot.
   */
  buffers: (Uint8Array | null)[];
  /** Files referenced by relative URI, keyed by the URI string exactly as written in the JSON. */
  externalFiles: Map<string, Uint8Array>;
  /** GLB only: every chunk of the container, in file order. */
  chunks?: GlbChunk[];
}

/** The result of the first parsing stage: the container opened and the JSON decoded, no resources resolved yet. */
export interface Container {
  format: 'gltf' | 'glb';
  json: GltfRoot;
  jsonBytes: Uint8Array;
  chunks?: GlbChunk[];
}

export interface ExternalRef {
  uri: string;
  /** Where the URI appears, for error messages, for example `buffers[0]` or `images[2]`. */
  owner: string;
}

function decodeJson(bytes: Uint8Array, label: string): GltfRoot {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GltfError('JSON_PARSE', `${label} is not valid UTF-8 text.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GltfError('JSON_PARSE', `${label} is not valid JSON: ${reason}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GltfError('JSON_ROOT', `${label} must contain a JSON object at the top level.`);
  }
  return value as GltfRoot;
}

/** Stage one: detect the format, open the container and decode the JSON. Pure, no I/O. */
export function parseContainer(bytes: Uint8Array): Container {
  if (isGlb(bytes)) {
    const chunks = parseGlbChunks(bytes);
    const jsonChunk = chunks[0];
    if (jsonChunk === undefined) throw new GltfError('GLB_CHUNK', 'The GLB file has no chunks.');
    return {
      format: 'glb',
      json: decodeJson(jsonChunk.data, 'The GLB JSON chunk'),
      jsonBytes: jsonChunk.data,
      chunks,
    };
  }
  return { format: 'gltf', json: decodeJson(bytes, 'The glTF file'), jsonBytes: bytes };
}

/** Relative URIs that point at files, from buffers and images, without duplicates, in document order. */
export function listExternalUris(json: GltfRoot): ExternalRef[] {
  const seen = new Set<string>();
  const refs: ExternalRef[] = [];
  const scan = (list: unknown, name: string): void => {
    if (!Array.isArray(list)) return;
    list.forEach((item: unknown, index) => {
      const uri = typeof item === 'object' && item !== null ? (item as { uri?: unknown }).uri : undefined;
      if (typeof uri !== 'string' || seen.has(uri)) return;
      if (classifyUri(uri) !== 'relative') return;
      seen.add(uri);
      refs.push({ uri, owner: `${name}[${index}]` });
    });
  };
  scan(json.buffers, 'buffers');
  scan(json.images, 'images');
  return refs;
}

/** Stage two: resolve every buffer to bytes. `files` supplies the relative-URI files. */
export function buildAsset(container: Container, files: ReadonlyMap<string, Uint8Array> = new Map()): Asset {
  const externalFiles = new Map<string, Uint8Array>();
  for (const ref of listExternalUris(container.json)) {
    const bytes = files.get(ref.uri);
    if (bytes === undefined) {
      throw new GltfError('RESOURCE_MISSING', `${ref.owner} points to "${ref.uri}" but no data was supplied for it.`);
    }
    externalFiles.set(ref.uri, bytes);
  }

  const bin = container.chunks?.find((chunk) => chunk.type === CHUNK_BIN)?.data ?? null;
  const declared: unknown[] = Array.isArray(container.json.buffers) ? container.json.buffers : [];
  const buffers = declared.map((entry, index): Uint8Array | null => {
    const uri = typeof entry === 'object' && entry !== null ? (entry as { uri?: unknown }).uri : undefined;
    if (typeof uri !== 'string') {
      return container.format === 'glb' && index === 0 ? bin : null;
    }
    switch (classifyUri(uri)) {
      case 'data':
        return decodeDataUri(uri).bytes;
      case 'remote':
        return null;
      case 'relative':
        return externalFiles.get(uri) ?? null;
    }
  });

  const asset: Asset = {
    format: container.format,
    json: container.json,
    jsonBytes: container.jsonBytes,
    buffers,
    externalFiles,
  };
  if (container.chunks !== undefined) asset.chunks = container.chunks;
  return asset;
}

/** Parses a .gltf or .glb held in memory. For a .gltf with external files, pass them in `files` by URI. */
export function parseAsset(bytes: Uint8Array, files: ReadonlyMap<string, Uint8Array> = new Map()): Asset {
  return buildAsset(parseContainer(bytes), files);
}

/**
 * Returns a copy of `asset` with a new JSON document. The JSON is re-encoded
 * compactly, so the result is no longer byte-identical to the original file.
 * Buffers are resolved again against the same external files and BIN chunk.
 */
export function withJson(asset: Asset, json: GltfRoot): Asset {
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  if (asset.format === 'glb') {
    const padded = new Uint8Array(Math.ceil(jsonBytes.byteLength / 4) * 4).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
    const rest = (asset.chunks ?? []).slice(1);
    return buildAsset(
      { format: 'glb', json, jsonBytes, chunks: [{ type: CHUNK_JSON, data: jsonBytes }, ...rest] },
      asset.externalFiles,
    );
  }
  return buildAsset({ format: 'gltf', json, jsonBytes }, asset.externalFiles);
}

/** Packs a GLB asset into file bytes. For an asset read with `parseAsset`, the output equals the input. */
export function serializeGlb(asset: Asset): Uint8Array {
  if (asset.format !== 'glb' || asset.chunks === undefined) {
    throw new GltfError('ASSET_STATE', 'serializeGlb needs a GLB asset. Converting a .gltf to GLB is not implemented yet.');
  }
  return serializeGlbChunks(asset.chunks);
}

/** Total bytes the asset occupies on disk: the GLB file, or the .gltf plus its external files. */
export function assetByteLength(asset: Asset): number {
  if (asset.format === 'glb' && asset.chunks !== undefined) {
    return 12 + asset.chunks.reduce((sum, chunk) => sum + 8 + chunk.data.byteLength, 0);
  }
  let total = asset.jsonBytes.byteLength;
  for (const bytes of asset.externalFiles.values()) total += bytes.byteLength;
  return total;
}
