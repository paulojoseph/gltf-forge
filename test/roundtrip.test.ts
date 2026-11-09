import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GltfError,
  assetByteLength,
  parseAsset,
  readAsset,
  serializeGlb,
  validate,
  withJson,
  writeAsset,
} from '../src/index.js';
import { FIXTURE_ASSETS, FIXTURE_FILES, fixtureBytes, fixturePath, loadFixture, loadGlb, mutated, withTempDir } from './helpers.js';

describe('round trip of untouched files', () => {
  it.each(FIXTURE_ASSETS)('writes %s back byte for byte, with every file it references', async (name) => {
    const asset = await loadFixture(name);
    await withTempDir(async (dir) => {
      await writeAsset(asset, join(dir, name));
      const written = new Set<string>();
      const sources = name.endsWith('.glb') ? [name] : [name, ...asset.externalFiles.keys()];
      for (const file of sources) {
        const original = await readFile(fixturePath(file));
        const copy = await readFile(join(dir, file));
        expect(Buffer.compare(copy, original), `${file} differs after the round trip`).toBe(0);
        written.add(file);
      }
      expect(written.size).toBe(sources.length);
    });
  });

  it.each(FIXTURE_ASSETS.filter((name) => name.endsWith('.glb')))('serializes %s in memory to the same bytes', (name) => {
    const bytes = fixtureBytes(name);
    expect(serializeGlb(parseAsset(bytes))).toEqual(bytes);
  });

  it('accounts for every fixture file on disk', async () => {
    const referenced = new Set<string>();
    for (const name of FIXTURE_ASSETS) {
      referenced.add(name);
      if (name.endsWith('.gltf')) for (const uri of (await loadFixture(name)).externalFiles.keys()) referenced.add(uri);
    }
    expect([...referenced].sort()).toEqual([...FIXTURE_FILES].sort());
  });

  it('keeps data URIs inside the JSON and does not write a file for them', async () => {
    const asset = await loadFixture('torus.gltf');
    expect(asset.externalFiles.size).toBe(0);
    expect(asset.buffers[0]?.byteLength).toBe(asset.json.buffers?.[0]?.byteLength);
    await withTempDir(async (dir) => {
      await writeAsset(asset, join(dir, 'torus.gltf'));
      expect(Buffer.compare(await readFile(join(dir, 'torus.gltf')), await readFile(fixturePath('torus.gltf')))).toBe(0);
    });
  });

  it('recreates the folder layout of a .gltf that keeps textures in a subfolder', async () => {
    const asset = await loadFixture('textured-cube.gltf');
    expect([...asset.externalFiles.keys()].sort()).toEqual(['textured-cube.bin', 'textures/crate-basecolor.png', 'textures/crate-normal.png', 'textures/crate-orm.png']);
    await withTempDir(async (dir) => {
      await writeAsset(asset, join(dir, 'out', 'cube.gltf'));
      expect((await readFile(join(dir, 'out', 'textures', 'crate-orm.png'))).byteLength).toBe(3172);
    });
  });

  it('detects the format from the content, not the extension', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'model.dat'), fixtureBytes('sphere.glb'));
      const asset = await readAsset(join(dir, 'model.dat'));
      expect(asset.format).toBe('glb');
    });
  });
});

describe('withJson', () => {
  it('changes the JSON, leaves the BIN chunk alone, and the result still parses and validates', () => {
    const original = parseAsset(fixtureBytes('sphere.glb'));
    const json = structuredClone(original.json);
    json.asset.generator = 'edited';
    const edited = withJson(original, json);

    expect(edited.json.asset.generator).toBe('edited');
    expect(edited.chunks?.length).toBe(2);
    expect(edited.chunks?.[1]).toBe(original.chunks?.[1]);
    expect(edited.jsonBytes.byteLength % 4).toBe(0);

    const reparsed = parseAsset(serializeGlb(edited));
    expect(reparsed.json.asset.generator).toBe('edited');
    expect(reparsed.buffers[0]).toEqual(original.buffers[0]);
    expect(validate(reparsed).ok).toBe(true);
  });

  it.each([0, 1, 2, 3, 4, 5])('pads the JSON chunk with spaces however long the text is (generator +%i chars)', (extra) => {
    const original = parseAsset(fixtureBytes('sphere.glb'));
    const json = structuredClone(original.json);
    json.asset.generator = `edited${'x'.repeat(extra)}`;
    const edited = withJson(original, json);
    const text = new TextEncoder().encode(JSON.stringify(json));
    expect(edited.jsonBytes.byteLength).toBe(Math.ceil(text.byteLength / 4) * 4);
    expect([...edited.jsonBytes.subarray(text.byteLength)].every((byte) => byte === 0x20)).toBe(true);
    expect(parseAsset(serializeGlb(edited)).json.asset.generator).toBe(json.asset.generator);
  });

  it('gives only the first buffer of a GLB the BIN chunk', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      json.buffers?.push({ byteLength: 4 });
    });
    expect(asset.buffers[0]).not.toBeNull();
    expect(asset.buffers[1]).toBeNull();
  });

  it('is the only operation that re-encodes: untouched assets keep their original JSON bytes', () => {
    const bytes = fixtureBytes('sphere.glb');
    const asset = parseAsset(bytes);
    const jsonText = new TextDecoder().decode(asset.jsonBytes).trimEnd();
    expect(jsonText).toBe(JSON.stringify(asset.json));
    expect(asset.jsonBytes).toEqual(bytes.subarray(20, 20 + asset.jsonBytes.byteLength));
  });

  it('works on a .gltf and keeps its external files', async () => {
    const original = await loadFixture('sphere.gltf');
    const json = structuredClone(original.json);
    json.asset.copyright = 'test';
    const edited = withJson(original, json);
    expect(edited.format).toBe('gltf');
    expect(edited.externalFiles.get('sphere.bin')).toBe(original.externalFiles.get('sphere.bin'));
    expect(JSON.parse(new TextDecoder().decode(edited.jsonBytes))).toMatchObject({ asset: { copyright: 'test' } });
  });
});

describe('reading and writing failures', () => {
  it('names the missing file and the buffer that pointed to it', async () => {
    await withTempDir(async (dir) => {
      const source = await readFile(fixturePath('sphere.gltf'));
      await writeFile(join(dir, 'sphere.gltf'), source);
      await expect(readAsset(join(dir, 'sphere.gltf'))).rejects.toThrow(/buffers\[0\] points to "sphere\.bin", but .*sphere\.bin could not be read/);
    });
  });

  it('reports a file that does not exist', async () => {
    await expect(readAsset(fixturePath('nope.glb'))).rejects.toMatchObject({ code: 'FILE_READ' });
  });

  it('reports JSON that does not parse', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'broken.gltf'), '{"asset": {');
      await expect(readAsset(join(dir, 'broken.gltf'))).rejects.toMatchObject({ code: 'JSON_PARSE' });
      await writeFile(join(dir, 'array.gltf'), '[]');
      await expect(readAsset(join(dir, 'array.gltf'))).rejects.toMatchObject({ code: 'JSON_ROOT' });
      await writeFile(join(dir, 'latin1.gltf'), Buffer.from([0x7b, 0x22, 0xe9, 0x22, 0x7d]));
      await expect(readAsset(join(dir, 'latin1.gltf'))).rejects.toMatchObject({ code: 'JSON_PARSE' });
      await expect(readAsset(join(dir, 'latin1.gltf'))).rejects.toThrow('not valid UTF-8');
    });
  });

  it('refuses a URI that climbs out of the folder, and allows it on request', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'models'));
      const json = { asset: { version: '2.0' }, buffers: [{ uri: '../shared.bin', byteLength: 4 }] };
      await writeFile(join(dir, 'models', 'a.gltf'), JSON.stringify(json));
      await writeFile(join(dir, 'shared.bin'), new Uint8Array(4));

      await expect(readAsset(join(dir, 'models', 'a.gltf'))).rejects.toMatchObject({ code: 'URI_UNSAFE' });
      const asset = await readAsset(join(dir, 'models', 'a.gltf'), { allowParentPaths: true });
      expect(asset.buffers[0]?.byteLength).toBe(4);
      await expect(writeAsset(asset, join(dir, 'out', 'a.gltf'))).rejects.toMatchObject({ code: 'URI_UNSAFE' });
    });
  });

  it('will not turn a .gltf into a GLB yet', async () => {
    const asset = await loadFixture('sphere.gltf');
    expect(() => serializeGlb(asset)).toThrowError(GltfError);
  });

  it('counts a .gltf together with its external files', async () => {
    const asset = await loadFixture('textured-cube.gltf');
    expect(assetByteLength(asset)).toBe(2616 + 840 + 16516 + 3172 + 3172);
    expect(assetByteLength(parseAsset(fixtureBytes('sphere.glb')))).toBe(24784);
  });
});
