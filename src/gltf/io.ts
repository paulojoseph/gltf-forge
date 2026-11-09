import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildAsset, listExternalUris, parseContainer, serializeGlb, type Asset } from './asset.js';
import { GltfError } from './errors.js';
import { relativeUriToSegments, type SegmentOptions } from './uri.js';

export type IoOptions = SegmentOptions;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads a .gltf or .glb from disk, loading every external buffer and image it references. */
export async function readAsset(filePath: string, options: IoOptions = {}): Promise<Asset> {
  let bytes: Uint8Array;
  try {
    const file = await readFile(filePath);
    bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  } catch (error) {
    throw new GltfError('FILE_READ', `Cannot read "${filePath}": ${describe(error)}`);
  }

  const container = parseContainer(bytes);
  const baseDir = dirname(resolve(filePath));
  const files = new Map<string, Uint8Array>();
  for (const ref of listExternalUris(container.json)) {
    const target = resolve(baseDir, ...relativeUriToSegments(ref.uri, options));
    try {
      const file = await readFile(target);
      files.set(ref.uri, new Uint8Array(file.buffer, file.byteOffset, file.byteLength));
    } catch (error) {
      throw new GltfError(
        'RESOURCE_MISSING',
        `${ref.owner} points to "${ref.uri}", but ${target} could not be read: ${describe(error)}`,
      );
    }
  }
  return buildAsset(container, files);
}

/**
 * Writes an asset to `filePath`. A GLB becomes one file. A .gltf is written next
 * to its external files, using the same relative layout the JSON refers to.
 */
export async function writeAsset(asset: Asset, filePath: string, options: IoOptions = {}): Promise<void> {
  const target = resolve(filePath);
  const baseDir = dirname(target);
  try {
    await mkdir(baseDir, { recursive: true });
    if (asset.format === 'glb') {
      await writeFile(target, serializeGlb(asset));
      return;
    }
    await writeFile(target, asset.jsonBytes);
    for (const [uri, bytes] of asset.externalFiles) {
      const path = resolve(baseDir, ...relativeUriToSegments(uri, options));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
  } catch (error) {
    if (error instanceof GltfError) throw error;
    throw new GltfError('FILE_WRITE', `Cannot write "${filePath}": ${describe(error)}`);
  }
}
