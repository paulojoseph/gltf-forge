import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { capture, fixturePath, withTempDir } from './helpers.js';

async function forge(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = capture();
  const code = await run(args, io);
  return { code, out: io.out(), err: io.err() };
}

describe('forge inspect', () => {
  it('prints the report and a clean validation line for a good file', async () => {
    const { code, out, err } = await forge('inspect', fixturePath('scene-50-nodes.glb'));
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('scene-50-nodes.glb  (GLB 2.0, 14.4 KiB on disk)');
    expect(out).toContain('total: 236 triangles stored, 4,956 drawn from the default scene');
    expect(out).toContain('vertex attributes       5,664 B   80.0%');
    expect(out.trimEnd().endsWith('Validation: no problems found.')).toBe(true);
  });

  it('follows external files of a .gltf', async () => {
    const { code, out } = await forge('inspect', fixturePath('textured-cube.gltf'));
    expect(code).toBe(0);
    expect(out).toContain('textures/crate-basecolor.png');
    expect(out).toContain('[0] textured-cube.bin (file), 840 B declared in 2 bufferViews');
  });

  it('prints JSON with the report and the validation result', async () => {
    const { code, out } = await forge('inspect', fixturePath('sphere.glb'), '--json');
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { file: string; validation: { ok: boolean; issues: unknown[] }; report: { totals: { triangles: number }; buffers: { declaredBytes: number }[] } };
    expect(parsed.validation).toMatchObject({ ok: true, issues: [] });
    expect(parsed.report.totals.triangles).toBe(960);
    expect(parsed.report.buffers[0]?.declaredBytes).toBe(23712);
  });

  it('lists validation errors after the report and exits 1', async () => {
    await withTempDir(async (dir) => {
      const broken = JSON.parse(readFileSync(fixturePath('sphere.gltf'), 'utf8')) as { meshes: { primitives: { attributes: Record<string, number> }[] }[] };
      const primitive = broken.meshes[0]?.primitives[0];
      if (primitive) primitive.attributes.NORMAL = 42;
      await writeFile(join(dir, 'broken.gltf'), JSON.stringify(broken));
      await writeFile(join(dir, 'sphere.bin'), readFileSync(fixturePath('sphere.bin')));
      const { code, out } = await forge('inspect', join(dir, 'broken.gltf'));
      expect(code).toBe(1);
      expect(out).toContain('Meshes');
      expect(out).toContain('error   meshes[0].primitives[0].attributes.NORMAL\n          accessors[42] does not exist; the asset has 4 accessors. [INDEX_OUT_OF_RANGE]');
      expect(out.trimEnd().endsWith('Validation: 1 error, 0 warnings.')).toBe(true);
    });
  });

  it('still lists the problems when the structure is too broken to build a report', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'odd.gltf'), JSON.stringify({ asset: { version: '2.0' }, meshes: 5 }));
      const { code, out } = await forge('inspect', join(dir, 'odd.gltf'));
      expect(code).toBe(1);
      expect(out).toContain('The report could not be built because the file is malformed');
      expect(out).toContain('"meshes" must be an array but is a number. [TYPE_MISMATCH]');
    });
  });

  it('passes --allow-parent-paths through to the reader', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'models'));
      await writeFile(join(dir, 'shared.bin'), new Uint8Array(4));
      await writeFile(join(dir, 'models', 'a.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: '../shared.bin', byteLength: 4 }] }));

      const refused = await forge('validate', join(dir, 'models', 'a.gltf'));
      expect(refused.code).toBe(2);
      expect(refused.err).toContain('climbs out of the asset folder');

      const allowed = await forge('validate', join(dir, 'models', 'a.gltf'), '--allow-parent-paths');
      expect(allowed.code).toBe(0);
    });
  });
});

describe('forge validate', () => {
  it('prints only the validation result', async () => {
    const { code, out } = await forge('validate', fixturePath('torus.glb'));
    expect(code).toBe(0);
    expect(out).toBe('Validation: no problems found.\n');
  });

  it('exits 0 when there are only warnings, and says how many', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'w.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.com/a.bin', byteLength: 4 }] }));
      const { code, out } = await forge('validate', join(dir, 'w.gltf'));
      expect(code).toBe(0);
      expect(out).toContain('warning buffers[0].uri');
      expect(out.trimEnd().endsWith('Validation: 0 errors, 1 warning.')).toBe(true);
    });
  });

  it('prints JSON issues with both path notations', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'v.gltf'), JSON.stringify({ asset: { version: '1.0' } }));
      const { code, out } = await forge('validate', join(dir, 'v.gltf'), '--json');
      expect(code).toBe(1);
      const parsed = JSON.parse(out) as { validation: { errors: number; issues: { path: string; location: string; code: string }[] } };
      expect(parsed.validation.errors).toBe(1);
      expect(parsed.validation.issues[0]).toMatchObject({ code: 'ASSET_VERSION', path: '/asset/version', location: 'asset.version' });
    });
  });
});

describe('usage and read errors', () => {
  it('shows help and exits 0', async () => {
    for (const flag of ['--help', '-h']) {
      const { code, out } = await forge(flag);
      expect(code).toBe(0);
      expect(out).toContain('forge inspect <file> [--json]');
      expect(out).toContain('Exit codes');
    }
    expect((await forge('inspect', '--help')).code).toBe(0);
  });

  it('prints the package version', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(await forge('--version')).toEqual({ code: 0, out: `${manifest.version}\n`, err: '' });
    expect((await forge('-v')).out).toBe(`${manifest.version}\n`);
  });

  it.each([
    [[], 'Missing command.'],
    [['convert', 'a.glb'], 'Unknown command "convert".'],
    [['inspect'], '"inspect" needs a file to read.'],
    [['validate', 'a.glb', 'b.glb'], 'Unexpected extra argument "b.glb". validate takes one file.'],
    [['inspect', 'a.glb', '--fast'], 'Unknown option "--fast".'],
  ])('exits 2 for %j', async (args, message) => {
    const { code, out, err } = await forge(...args);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toBe(`forge: ${message}\nRun "forge --help" for usage.\n`);
  });

  it('exits 2 and names the file when it cannot be read', async () => {
    const { code, err } = await forge('inspect', fixturePath('missing.glb'));
    expect(code).toBe(2);
    expect(err).toMatch(/^forge: Cannot read ".*missing\.glb": ENOENT/);
  });

  it('exits 2 for a file that is not glTF at all', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'notes.txt'), 'hello');
      const { code, err } = await forge('validate', join(dir, 'notes.txt'));
      expect(code).toBe(2);
      expect(err).toContain('The glTF file is not valid JSON');
    });
  });
});
