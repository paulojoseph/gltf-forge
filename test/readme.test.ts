import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatReport, inspectAsset } from '../src/index.js';
import { FIXTURE_ASSETS, loadFixture, loadGlb } from './helpers.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const n = (value: number): string => value.toLocaleString('en-US');

describe('README numbers', () => {
  it.each(FIXTURE_ASSETS)('the "before" table row for %s matches the measured values', async (name) => {
    const report = inspectAsset(await loadFixture(name));
    const encoded = report.images.reduce((sum, image) => sum + (image.encodedBytes ?? 0), 0);
    const gpu = report.images.reduce((sum, image) => sum + (image.gpuBytes ?? 0), 0);
    const row = `| ${name} | ${n(report.file.bytes)} | ${n(report.totals.triangles)} | ${n(report.totals.drawnTriangles)} | ${n(encoded)} | ${n(gpu)} |`;
    expect(readme).toContain(row);
  });

  it('shows the real output of `forge inspect` for the textured cube', () => {
    const text = formatReport(inspectAsset(loadGlb('textured-cube.glb'), { name: 'textured-cube.glb' }));
    expect(readme).toContain(text);
  });
});
