import { describe, expect, it } from 'vitest';
import {
  CHUNK_BIN,
  CHUNK_JSON,
  GltfError,
  chunkTypeName,
  isGlb,
  parseGlbChunks,
  serializeGlbChunks,
  type GltfErrorCode,
} from '../src/index.js';
import { fixtureBytes, makeGlb, setU32 } from './helpers.js';

function failure(run: () => unknown): GltfError {
  try {
    run();
  } catch (error) {
    if (error instanceof GltfError) return error;
    throw error;
  }
  throw new Error('expected a GltfError, but nothing was thrown');
}

describe('parseGlbChunks', () => {
  it('splits a real GLB into a JSON chunk and a BIN chunk', () => {
    const chunks = parseGlbChunks(fixtureBytes('sphere.glb'));
    expect(chunks.map((c) => chunkTypeName(c.type))).toEqual(['JSON', 'BIN']);
    expect(chunks[0]?.data.byteLength).toBeGreaterThan(0);
    expect(chunks[1]?.data.byteLength).toBe(23712);
  });

  it('writes the chunks back to the exact bytes it read', () => {
    for (const name of ['sphere.glb', 'torus.glb', 'textured-cube.glb', 'scene-50-nodes.glb']) {
      const bytes = fixtureBytes(name);
      expect(serializeGlbChunks(parseGlbChunks(bytes))).toEqual(bytes);
    }
  });

  it('keeps chunks it does not understand, in order', () => {
    const unknown = { type: 0x12345678, data: new Uint8Array([1, 2, 3, 4]) };
    const original = parseGlbChunks(makeGlb({ asset: { version: '2.0' } }, new Uint8Array(8)));
    const bytes = serializeGlbChunks([...original, unknown]);
    const chunks = parseGlbChunks(bytes);
    expect(chunks.map((c) => c.type)).toEqual([CHUNK_JSON, CHUNK_BIN, 0x12345678]);
    expect(serializeGlbChunks(chunks)).toEqual(bytes);
  });

  it('recognises GLB by its magic bytes, not by file name', () => {
    expect(isGlb(fixtureBytes('sphere.glb'))).toBe(true);
    expect(isGlb(fixtureBytes('sphere.gltf'))).toBe(false);
    expect(isGlb(new Uint8Array(2))).toBe(false);
  });
});

describe('parseGlbChunks errors', () => {
  const cases: { name: string; code: GltfErrorCode; message: RegExp; bytes: () => Uint8Array }[] = [
    {
      name: 'a file shorter than the header',
      code: 'GLB_HEADER',
      message: /4 bytes long, but the GLB header alone takes 12/,
      bytes: () => new Uint8Array(4),
    },
    {
      name: 'the wrong magic bytes',
      code: 'GLB_HEADER',
      message: /expected the magic bytes "glTF".*0x00000000/,
      bytes: () => new Uint8Array(16),
    },
    {
      name: 'container version 1',
      code: 'GLB_VERSION',
      message: /container version 1\. Only version 2/,
      bytes: () => {
        const bytes = fixtureBytes('sphere.glb');
        setU32(bytes, 4, 1);
        return bytes;
      },
    },
    {
      name: 'trailing bytes after the last chunk',
      code: 'GLB_LENGTH',
      message: /declares 24784 bytes but the file is 24785 bytes long/,
      bytes: () => {
        const bytes = fixtureBytes('sphere.glb');
        const longer = new Uint8Array(bytes.byteLength + 1);
        longer.set(bytes);
        return longer;
      },
    },
    {
      name: 'a truncated file',
      code: 'GLB_LENGTH',
      message: /declares 24784 bytes but the file is 1000 bytes long/,
      bytes: () => fixtureBytes('sphere.glb').slice(0, 1000),
    },
    {
      name: 'a chunk that claims more bytes than remain',
      code: 'GLB_CHUNK',
      message: /Chunk 1 \(BIN\) claims 23712 bytes but only 10 bytes remain/,
      bytes: () => {
        const full = fixtureBytes('sphere.glb');
        const jsonLength = new DataView(full.buffer).getUint32(12, true);
        const cut = full.slice(0, 20 + jsonLength + 8 + 10);
        setU32(cut, 8, cut.byteLength);
        return cut;
      },
    },
    {
      name: 'a chunk that claims only 4 bytes more than remain',
      code: 'GLB_CHUNK',
      message: /Chunk 1 \(BIN\) claims 23716 bytes but only 23712 bytes remain/,
      bytes: () => {
        const bytes = fixtureBytes('sphere.glb');
        const jsonLength = new DataView(bytes.buffer).getUint32(12, true);
        setU32(bytes, 20 + jsonLength, 23716);
        return bytes;
      },
    },
    {
      name: 'a chunk length that is not a multiple of 4',
      code: 'GLB_CHUNK',
      message: /Chunk 0 \(JSON\) is \d+ bytes long\. The GLB spec requires chunk lengths to be multiples of 4/,
      bytes: () => {
        const bytes = fixtureBytes('sphere.glb');
        setU32(bytes, 12, new DataView(bytes.buffer).getUint32(12, true) - 1);
        return bytes;
      },
    },
    {
      name: 'a header with no room for a chunk header',
      code: 'GLB_CHUNK',
      message: /Chunk 0 starts at byte 12 but only 4 bytes remain/,
      bytes: () => {
        const bytes = new Uint8Array(16);
        setU32(bytes, 0, 0x46546c67);
        setU32(bytes, 4, 2);
        setU32(bytes, 8, 16);
        return bytes;
      },
    },
    {
      name: 'a file with no chunks',
      code: 'GLB_CHUNK',
      message: /has no chunks/,
      bytes: () => serializeGlbChunks([]),
    },
    {
      name: 'a first chunk that is not JSON',
      code: 'GLB_CHUNK',
      message: /first GLB chunk must be JSON but chunk 0 is BIN/,
      bytes: () => serializeGlbChunks([{ type: CHUNK_BIN, data: new Uint8Array(4) }]),
    },
    {
      name: 'two BIN chunks',
      code: 'GLB_CHUNK',
      message: /2 BIN chunks\. It may have at most one/,
      bytes: () => {
        const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}  ');
        return serializeGlbChunks([
          { type: CHUNK_JSON, data: json.slice(0, json.byteLength - (json.byteLength % 4)) },
          { type: CHUNK_BIN, data: new Uint8Array(4) },
          { type: CHUNK_BIN, data: new Uint8Array(4) },
        ]);
      },
    },
  ];

  it.each(cases)('rejects $name', ({ code, message, bytes }) => {
    const error = failure(() => parseGlbChunks(bytes()));
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
  });

  it('refuses to write a chunk whose length is not a multiple of 4', () => {
    const error = failure(() => serializeGlbChunks([{ type: CHUNK_JSON, data: new Uint8Array(3) }]));
    expect(error.message).toContain('multiples of 4');
  });
});
