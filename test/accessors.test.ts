import { describe, expect, it } from 'vitest';
import { elementByteSize, parseAsset, readAccessor } from '../src/index.js';
import { loadFixture, loadGlb, makeGlb } from './helpers.js';

function syntheticAsset(accessor: object, bin: Uint8Array, viewExtras: object = {}) {
  return parseAsset(
    makeGlb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: bin.byteLength }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength, ...viewExtras }],
        accessors: [{ bufferView: 0, ...accessor }],
      },
      bin,
    ),
  );
}

describe('elementByteSize', () => {
  it('multiplies components by component size', () => {
    expect(elementByteSize('VEC3', 5126)).toBe(12);
    expect(elementByteSize('SCALAR', 5123)).toBe(2);
    expect(elementByteSize('MAT4', 5126)).toBe(64);
  });

  it('pads matrix columns to 4 bytes', () => {
    expect(elementByteSize('MAT2', 5121)).toBe(8);
    expect(elementByteSize('MAT3', 5121)).toBe(12);
    expect(elementByteSize('MAT3', 5123)).toBe(24);
    expect(elementByteSize('MAT2', 5123)).toBe(8);
    expect(elementByteSize('MAT3', 5126)).toBe(36);
  });

  it('returns undefined for combinations that do not exist', () => {
    expect(elementByteSize('VEC3', 1234)).toBeUndefined();
    expect(elementByteSize('VEC9' as 'VEC3', 5126)).toBeUndefined();
  });
});

describe('readAccessor on the fixtures', () => {
  it('reads tightly packed positions, normals and UVs of the sphere', () => {
    const asset = loadGlb('sphere.glb');
    const position = readAccessor(asset, 0);
    expect(position.count).toBe(561);
    expect(position.componentCount).toBe(3);
    expect(position.values).toBeInstanceOf(Float32Array);
    // Ring 0 is the top pole of a sphere with radius 0.5.
    expect([...position.values.slice(0, 3)]).toEqual([0, 0.5, 0]);
    expect([...readAccessor(asset, 1).values.slice(0, 3)]).toEqual([0, 1, 0]);
    expect(readAccessor(asset, 2).componentCount).toBe(2);
  });

  it('reads 16-bit and 32-bit indices as the matching array types', async () => {
    const sphere = readAccessor(loadGlb('sphere.glb'), 3);
    expect(sphere.values).toBeInstanceOf(Uint16Array);
    expect(sphere.count).toBe(2880);
    const torus = readAccessor(await loadFixture('torus.gltf'), 3);
    expect(torus.values).toBeInstanceOf(Uint32Array);
    expect(torus.count).toBe(6912);
  });

  it('follows byteStride through interleaved attributes', async () => {
    const cube = await loadFixture('textured-cube.gltf');
    const position = readAccessor(cube, 0);
    const normal = readAccessor(cube, 1);
    const uv = readAccessor(cube, 2);
    expect(position.count).toBe(24);
    expect([...position.values.slice(0, 3)]).toEqual([-0.5, -0.5, 0.5]);
    expect([...normal.values.slice(0, 3)]).toEqual([0, 0, 1]);
    expect([...uv.values.slice(0, 2)]).toEqual([0, 1]);
    // The second vertex must come from 32 bytes further on, not from the next float.
    expect([...position.values.slice(3, 6)]).toEqual([0.5, -0.5, 0.5]);
    expect([...readAccessor(cube, 3).values.slice(0, 6)]).toEqual([0, 1, 2, 0, 2, 3]);
  });
});

describe('readAccessor on synthetic data', () => {
  it('skips the padding bytes of a MAT3 of unsigned bytes', () => {
    const bin = Uint8Array.from([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 11, 12, 13, 0, 14, 15, 16, 0, 17, 18, 19, 0]);
    const data = readAccessor(syntheticAsset({ componentType: 5121, count: 2, type: 'MAT3' }, bin), 0);
    expect([...data.values]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('honours byteStride and accessor byteOffset', () => {
    // Three VEC2 of UNSIGNED_SHORT, 8 bytes apart, starting 2 bytes in.
    const bin = new Uint8Array(24);
    const view = new DataView(bin.buffer);
    [0xaaaa, 1, 2, 0xbbbb, 0xbbbb, 3, 4, 0xbbbb, 0xbbbb, 5, 6, 0xbbbb].forEach((v, i) => view.setUint16(i * 2, v, true));
    const data = readAccessor(syntheticAsset({ componentType: 5123, count: 3, type: 'VEC2', byteOffset: 2 }, bin, { byteStride: 8 }), 0);
    expect([...data.values]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('reads signed components with their sign', () => {
    const data = readAccessor(syntheticAsset({ componentType: 5120, count: 4, type: 'SCALAR' }, Uint8Array.from([255, 1, 128, 127])), 0);
    expect([...data.values]).toEqual([-1, 1, -128, 127]);
  });

  it('returns zeros for an accessor with no bufferView, as the spec says', () => {
    const asset = parseAsset(makeGlb({ asset: { version: '2.0' }, accessors: [{ componentType: 5126, count: 2, type: 'VEC3' }] }));
    expect([...readAccessor(asset, 0).values]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('readAccessor errors', () => {
  it('says which accessor does not exist and how many there are', () => {
    expect(() => readAccessor(loadGlb('sphere.glb'), 9)).toThrowError('accessors[9]: it does not exist; the asset has 4 accessors.');
  });

  it('refuses sparse accessors instead of returning wrong data', () => {
    const asset = syntheticAsset({ componentType: 5126, count: 1, type: 'SCALAR', sparse: { count: 1, indices: { bufferView: 0, componentType: 5123 }, values: { bufferView: 0 } } }, new Uint8Array(8));
    expect(() => readAccessor(asset, 0)).toThrowError(/sparse accessors are not supported yet/);
  });

  it('reports a read that runs past the end of the buffer', () => {
    const asset = syntheticAsset({ componentType: 5126, count: 4, type: 'SCALAR' }, new Uint8Array(8));
    expect(() => readAccessor(asset, 0)).toThrowError(/reads bytes 0 to 16 of buffers\[0\], which only holds 8 bytes/);
  });

  it('reports a buffer whose data is not available', () => {
    const asset = parseAsset(
      makeGlb({
        asset: { version: '2.0' },
        buffers: [{ uri: 'https://example.com/a.bin', byteLength: 12 }],
        bufferViews: [{ buffer: 0, byteLength: 12 }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'SCALAR' }],
      }),
    );
    expect(() => readAccessor(asset, 0)).toThrowError(/the data of buffers\[0\] is not available/);
  });
});
