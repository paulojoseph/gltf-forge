import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHUNK_BIN, CHUNK_JSON, parseAsset, readAsset, serializeGlbChunks, withJson, type Asset, type GltfRoot } from '../src/index.js';

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** Every file the generator writes, relative to fixtures/. */
export const FIXTURE_FILES = [
  'scene-50-nodes.glb',
  'sphere.bin',
  'sphere.glb',
  'sphere.gltf',
  'textured-cube.bin',
  'textured-cube.glb',
  'textured-cube.gltf',
  'textures/crate-basecolor.png',
  'textures/crate-normal.png',
  'textures/crate-orm.png',
  'torus.glb',
  'torus.gltf',
];

/** The assets worth opening: each .gltf and .glb, which pull their own buffers and images in. */
export const FIXTURE_ASSETS = FIXTURE_FILES.filter((name) => name.endsWith('.gltf') || name.endsWith('.glb'));

export const fixturePath = (name: string): string => join(FIXTURE_DIR, name);

/** A private copy of the file's bytes, so a test can patch them freely. */
export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(name)));
}

export function loadFixture(name: string): Promise<Asset> {
  return readAsset(fixturePath(name));
}

/** Parses a GLB fixture from a private copy of its bytes. */
export function loadGlb(name: string): Asset {
  return parseAsset(fixtureBytes(name));
}

/** Copies the asset's JSON, lets `edit` change it, and returns the re-packed asset. */
export function mutated(asset: Asset, edit: (json: GltfRoot) => void): Asset {
  const json = structuredClone(asset.json);
  edit(json);
  return withJson(asset, json);
}

/** Opens a GLB fixture and lets `edit` change the bytes of its BIN chunk in place. */
export function patchedGlb(name: string, edit: (bin: Uint8Array, json: GltfRoot) => void): Asset {
  const asset = loadGlb(name);
  const bin = asset.buffers[0];
  if (bin === null || bin === undefined) throw new Error(`${name} has no BIN chunk`);
  edit(bin, asset.json);
  return asset;
}

/** Packs a small GLB from a JSON object and optional binary payload. */
export function makeGlb(json: object, bin?: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonData = new Uint8Array(Math.ceil(text.byteLength / 4) * 4).fill(0x20);
  jsonData.set(text);
  const chunks = [{ type: CHUNK_JSON, data: jsonData }];
  if (bin !== undefined) {
    const binData = new Uint8Array(Math.ceil(bin.byteLength / 4) * 4);
    binData.set(bin);
    chunks.push({ type: CHUNK_BIN, data: binData });
  }
  return serializeGlbChunks(chunks);
}

export function setU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

export function setU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

export async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'gltf-forge-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Collects what a CLI run writes. */
export function capture(): { stdout: { write(text: string): void }; stderr: { write(text: string): void }; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    stdout: { write: (text: string) => void (out += text) },
    stderr: { write: (text: string) => void (err += text) },
    out: () => out,
    err: () => err,
  };
}
