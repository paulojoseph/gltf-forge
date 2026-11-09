import { describe, expect, it } from 'vitest';
import { formatBytes, formatReport, inspectAsset, parseAsset } from '../src/index.js';
import { loadFixture, loadGlb, makeGlb, mutated } from './helpers.js';

describe('inspectAsset: triangle counts', () => {
  it('counts the sphere (32 segments, 16 rings, single triangles at the poles)', () => {
    const report = inspectAsset(loadGlb('sphere.glb'), { name: 'sphere.glb' });
    expect(report.meshes).toHaveLength(1);
    expect(report.meshes[0]).toMatchObject({
      index: 0,
      name: 'Sphere',
      vertices: 561,
      triangles: 960,
      instances: 1,
      drawnTriangles: 960,
      primitives: [{ mode: 'TRIANGLES', vertices: 561, indices: 2880, triangles: 960, material: 0 }],
    });
    expect(report.file).toEqual({ name: 'sphere.glb', format: 'glb', bytes: 24784 });
  });

  it('counts the torus, whose indices are 32 bits wide', async () => {
    const report = inspectAsset(await loadFixture('torus.gltf'));
    expect(report.meshes[0]).toMatchObject({ vertices: 1225, triangles: 2304 });
    expect(report.meshes[0]?.primitives[0]?.indices).toBe(6912);
  });

  it('counts instances through the node tree, so shared meshes are drawn many times', () => {
    const report = inspectAsset(loadGlb('scene-50-nodes.glb'));
    expect(report.counts).toMatchObject({ nodes: 50, meshes: 2, scenes: 1 });
    expect(report.meshes.map((m) => [m.name, m.triangles, m.instances, m.drawnTriangles])).toEqual([
      ['Block', 12, 21, 252],
      ['Ball', 224, 21, 4704],
    ]);
    expect(report.totals).toEqual({ vertices: 177, triangles: 236, drawnTriangles: 4956 });
  });

  it('only counts nodes reachable from the default scene', () => {
    const asset = mutated(loadGlb('scene-50-nodes.glb'), (json) => {
      // Scene 1 holds a single leaf; scene 0 is left as it was, so choosing scene 1 must change the count.
      json.scenes = [{ nodes: [0] }, { nodes: [2] }];
      json.scene = 1;
    });
    const report = inspectAsset(asset);
    expect(report.defaultScene).toBe(1);
    expect(report.totals.drawnTriangles).toBe(12);
  });

  it('counts every mesh node when the file has no scenes', () => {
    const asset = mutated(loadGlb('scene-50-nodes.glb'), (json) => {
      delete json.scenes;
      delete json.scene;
    });
    const report = inspectAsset(asset);
    expect(report.defaultScene).toBeNull();
    expect(report.totals.drawnTriangles).toBe(4956);
  });

  it('computes triangles from the draw mode', () => {
    const bin = new Uint8Array(12 * 6);
    const json = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.byteLength }],
      bufferViews: [{ buffer: 0, byteLength: bin.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 6, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0] }],
      meshes: [4, 5, 6, 1, 0].map((mode) => ({ primitives: [{ attributes: { POSITION: 0 }, mode }] })),
    };
    const report = inspectAsset(parseAsset(makeGlb(json, bin)));
    expect(report.meshes.map((m) => [m.primitives[0]?.mode, m.triangles])).toEqual([
      ['TRIANGLES', 2],
      ['TRIANGLE_STRIP', 4],
      ['TRIANGLE_FAN', 4],
      ['LINES', 0],
      ['POINTS', 0],
    ]);
  });
});

describe('inspectAsset: incomplete triangles', () => {
  it('does not count a partial triangle', () => {
    const bin = new Uint8Array(12 * 7);
    const json = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.byteLength }],
      bufferViews: [{ buffer: 0, byteLength: bin.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 7, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    };
    expect(inspectAsset(parseAsset(makeGlb(json, bin))).meshes[0]?.triangles).toBe(2);
  });
});

describe('inspectAsset: textures', () => {
  it('reports size, encoded bytes, the estimated GPU cost and which material slots use each image', () => {
    const { images } = inspectAsset(loadGlb('textured-cube.glb'));
    expect(images.map((i) => [i.name, i.width, i.height, i.encodedBytes, i.gpuBytes])).toEqual([
      ['crate_basecolor', 64, 64, 16516, 21844],
      ['crate_orm', 32, 32, 3172, 5460],
      ['crate_normal', 32, 32, 3172, 5460],
    ]);
    expect(images.map((i) => i.usedBy)).toEqual([['materials[0].baseColor'], ['materials[0].metallicRoughness', 'materials[0].occlusion'], ['materials[0].normal']]);
    expect(images.every((i) => i.source === 'bufferView' && i.format === 'png' && i.mimeType === 'image/png')).toBe(true);
  });

  it('reads external image files and keeps the uri', async () => {
    const { images } = inspectAsset(await loadFixture('textured-cube.gltf'));
    expect(images[0]).toMatchObject({ source: 'file', uri: 'textures/crate-basecolor.png', width: 64, encodedBytes: 16516 });
  });

  it('shortens data URIs and marks unreachable images instead of failing', () => {
    const asset = parseAsset(
      makeGlb({ asset: { version: '2.0' }, images: [{ uri: 'data:image/png;base64,AAAA' }, { uri: 'https://example.com/a.png' }, {}] }),
    );
    const { images } = inspectAsset(asset);
    expect(images.map((i) => [i.source, i.uri, i.width])).toEqual([
      ['data-uri', 'data:image/png;base64,...', null],
      ['remote', 'https://example.com/a.png', null],
      ['missing', null, null],
    ]);
    expect(images.every((i) => i.gpuBytes === null)).toBe(true);
  });
});

describe('inspectAsset: byte budget of each buffer', () => {
  it('splits the sphere buffer into attributes and indices that add up to its length', () => {
    const [buffer] = inspectAsset(loadGlb('sphere.glb')).buffers;
    expect(buffer).toMatchObject({
      index: 0,
      source: 'glb-bin',
      uri: null,
      declaredBytes: 23712,
      availableBytes: 23712,
      views: 4,
      unusedViews: 0,
      gaps: 0,
      categories: { vertexAttributes: 17952, indices: 5760, images: 0, animation: 0, skinning: 0, other: 0 },
    });
  });

  it('attributes embedded image bytes to images', () => {
    const [buffer] = inspectAsset(loadGlb('textured-cube.glb')).buffers;
    expect(buffer?.categories).toMatchObject({ vertexAttributes: 768, indices: 72, images: 16516 + 3172 + 3172 });
    const sum = Object.values(buffer?.categories ?? {}).reduce((a, b) => a + b, 0);
    expect(sum + (buffer?.unusedViews ?? 0) + (buffer?.gaps ?? 0)).toBe(buffer?.declaredBytes);
  });

  it('reports the source of a buffer: external file or data URI', async () => {
    expect(inspectAsset(await loadFixture('sphere.gltf')).buffers[0]).toMatchObject({ source: 'file', uri: 'sphere.bin' });
    expect(inspectAsset(await loadFixture('torus.gltf')).buffers[0]).toMatchObject({ source: 'data-uri', uri: 'data:application/octet-stream;base64,...' });
  });

  it('finds bytes that nothing refers to: padding between views, an unused view and a tail', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      // Drop the normals and UVs from the primitive: their views are then unused.
      const primitive = json.meshes?.[0]?.primitives[0];
      if (primitive) primitive.attributes = { POSITION: 0 };
      json.accessors = json.accessors?.slice(0, 1).concat(json.accessors.slice(3));
      if (primitive) primitive.indices = 1;
      // Shrink the last view so a tail of the buffer is covered by nothing.
      const last = json.bufferViews?.[3];
      if (last) last.byteLength = 5000;
    });
    const [buffer] = inspectAsset(asset).buffers;
    expect(buffer?.categories.vertexAttributes).toBe(6732);
    expect(buffer?.categories.indices).toBe(5000);
    expect(buffer?.unusedViews).toBe(6732 + 4488);
    expect(buffer?.gaps).toBe(23712 - 6732 - 6732 - 4488 - 5000);
  });

  it('counts overlapping views once', () => {
    const bin = new Uint8Array(64);
    const json = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 64 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 40 },
        { buffer: 0, byteOffset: 24, byteLength: 40 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 1, type: 'SCALAR' },
        { bufferView: 1, componentType: 5126, count: 1, type: 'SCALAR' },
      ],
    };
    const [buffer] = inspectAsset(parseAsset(makeGlb(json, bin))).buffers;
    expect(buffer?.categories.other).toBe(64);
    expect(buffer?.gaps).toBe(0);
  });

  it('attributes animation and skinning data', () => {
    const bin = new Uint8Array(128);
    const json = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 128 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 8 },
        { buffer: 0, byteOffset: 8, byteLength: 24 },
        { buffer: 0, byteOffset: 32, byteLength: 64 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' },
        { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: 1, type: 'MAT4' },
      ],
      nodes: [{}],
      skins: [{ joints: [0], inverseBindMatrices: 2 }],
      animations: [{ samplers: [{ input: 0, output: 1 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }],
    };
    const [buffer] = inspectAsset(parseAsset(makeGlb(json, bin))).buffers;
    expect(buffer).toMatchObject({ categories: { animation: 32, skinning: 64 }, gaps: 32 });
  });

  it('notes when the data on hand is not the declared length', async () => {
    const asset = mutated(await loadFixture('sphere.gltf'), (json) => {
      if (json.buffers?.[0]) json.buffers[0].byteLength = 20000;
    });
    expect(formatReport(inspectAsset(asset))).toContain('note: 23,712 B are available but 20,000 B are declared');
  });
});

describe('formatReport', () => {
  it('prints a readable summary of the textured cube', () => {
    const text = formatReport(inspectAsset(loadGlb('textured-cube.glb'), { name: 'textured-cube.glb' }));
    expect(text.split('\n')).toEqual(
      expect.arrayContaining([
        'textured-cube.glb  (GLB 2.0, 24.7 KiB on disk)',
        'generator: gltf-forge fixture generator',
        'scenes 1, nodes 1, meshes 1, materials 1, textures 3, images 3, animations 0, skins 0',
        '  0  Crate      1        24         12          1     12',
        '  total: 12 triangles stored, 12 drawn from the default scene',
        '  [0] GLB BIN chunk, 23,700 B declared in 5 bufferViews',
      ]),
    );
    expect(text).toContain('64x64');
    expect(text).toContain('materials[0].metallicRoughness, materials[0].occlusion');
    expect(text).toContain('embedded images        22,860 B   96.5%');
  });

  it('says "none" for sections an asset does not have', () => {
    const text = formatReport(inspectAsset(parseAsset(makeGlb({ asset: { version: '2.0' } }))));
    expect(text).toMatch(/Meshes\n {2}none\n\nTextures\n {2}none\n\nBuffers\n {2}none/);
  });

  it('lists extensions and which of them are required', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      json.extensionsUsed = ['KHR_materials_unlit', 'KHR_texture_transform'];
      json.extensionsRequired = ['KHR_texture_transform'];
    });
    expect(formatReport(inspectAsset(asset))).toContain('extensions: KHR_materials_unlit, KHR_texture_transform (required: KHR_texture_transform)');
  });
});

describe('formatBytes', () => {
  it('switches units at 1024', () => {
    expect([0, 1023, 1024, 1536, 1048575, 1048576, 5 * 1024 * 1024].map(formatBytes)).toEqual(['0 B', '1023 B', '1.0 KiB', '1.5 KiB', '1024.0 KiB', '1.00 MiB', '5.00 MiB']);
  });
});
