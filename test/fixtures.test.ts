import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ASSETS, loadFixture } from './helpers.js';

describe('fixtures', () => {
  it('match what scripts/generate-fixtures.mjs produces, byte for byte', () => {
    const script = fileURLToPath(new URL('../scripts/generate-fixtures.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(output.trim()).toBe('12 fixtures match the generator.');
  });

  it('cover both container formats, every storage form for data, and both index widths', async () => {
    const assets = await Promise.all(FIXTURE_ASSETS.map(async (name) => ({ name, asset: await loadFixture(name) })));
    const formats = new Set(assets.map(({ asset }) => asset.format));
    expect(formats).toEqual(new Set(['gltf', 'glb']));

    const kinds = new Set<string>();
    for (const { asset } of assets) {
      for (const buffer of asset.json.buffers ?? []) kinds.add(buffer.uri === undefined ? 'bin-chunk' : buffer.uri.startsWith('data:') ? 'data-uri' : 'file');
      for (const image of asset.json.images ?? []) kinds.add(image.bufferView !== undefined ? 'image-in-view' : 'image-file');
    }
    expect(kinds).toEqual(new Set(['bin-chunk', 'data-uri', 'file', 'image-in-view', 'image-file']));

    const indexTypes = new Set(assets.flatMap(({ asset }) => (asset.json.accessors ?? []).filter((a) => a.type === 'SCALAR').map((a) => a.componentType)));
    expect(indexTypes).toEqual(new Set([5123, 5125]));
  });

  it('include the 50-node scene', async () => {
    expect((await loadFixture('scene-50-nodes.glb')).json.nodes).toHaveLength(50);
  });
});
