import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getImageBytes, parseAsset, readImageInfo } from '../src/index.js';
import { fixturePath, loadFixture, loadGlb, makeGlb } from './helpers.js';

/** A JPEG skeleton: SOI, a JFIF APP0 segment, then a baseline frame header. No pixel data. */
function jpegHeader(width: number, height: number, markerBeforeFrame = 0xe0): Uint8Array {
  const app = [0xff, markerBeforeFrame, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const frame = [0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00];
  return Uint8Array.from([0xff, 0xd8, ...app, ...frame]);
}

function ktx2Header(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(80);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  return bytes;
}

describe('readImageInfo', () => {
  it('reads the size of the PNG textures the fixtures embed', async () => {
    expect(readImageInfo(new Uint8Array(await readFile(fixturePath('textures/crate-basecolor.png'))))).toEqual({ format: 'png', width: 64, height: 64 });
    expect(readImageInfo(new Uint8Array(await readFile(fixturePath('textures/crate-normal.png'))))).toEqual({ format: 'png', width: 32, height: 32 });
  });

  it('keeps width and height apart in a PNG that is not square', () => {
    const header = new Uint8Array(33);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const view = new DataView(header.buffer);
    view.setUint32(16, 1024);
    view.setUint32(20, 5);
    expect(readImageInfo(header)).toEqual({ format: 'png', width: 1024, height: 5 });
  });

  it('reads a JPEG frame header after other segments', () => {
    expect(readImageInfo(jpegHeader(1920, 1080))).toEqual({ format: 'jpeg', width: 1920, height: 1080 });
    expect(readImageInfo(jpegHeader(300, 200, 0xe1))).toEqual({ format: 'jpeg', width: 300, height: 200 });
  });

  it('reads a KTX2 header', () => {
    expect(readImageInfo(ktx2Header(512, 256))).toEqual({ format: 'ktx2', width: 512, height: 256 });
  });

  it('returns null for unknown formats and damaged headers instead of guessing', () => {
    expect(readImageInfo(new Uint8Array(0))).toBeNull();
    expect(readImageInfo(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBeNull();
    expect(readImageInfo(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBeNull();
    expect(readImageInfo(jpegHeader(10, 10).subarray(0, 25))).toBeNull();
    expect(readImageInfo(Uint8Array.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
    expect(readImageInfo(ktx2Header(1, 1).subarray(0, 20))).toBeNull();
  });
});

describe('getImageBytes', () => {
  it('finds an image in a bufferView of a GLB', () => {
    const asset = loadGlb('textured-cube.glb');
    const bytes = getImageBytes(asset, 0);
    expect(bytes?.byteLength).toBe(16516);
    expect(readImageInfo(bytes ?? new Uint8Array())?.width).toBe(64);
  });

  it('finds an image that is an external file', async () => {
    const asset = await loadFixture('textured-cube.gltf');
    expect(getImageBytes(asset, 2)?.byteLength).toBe(3172);
  });

  it('decodes an image stored as a data URI', async () => {
    const png = await readFile(fixturePath('textures/crate-orm.png'));
    const asset = parseAsset(
      new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: `data:image/png;base64,${png.toString('base64')}` }] })),
    );
    expect(getImageBytes(asset, 0)).toEqual(new Uint8Array(png));
  });

  it('returns null when the bytes cannot be reached', () => {
    const remote = parseAsset(makeGlb({ asset: { version: '2.0' }, images: [{ uri: 'https://example.com/a.png' }, {}] }));
    expect(getImageBytes(remote, 0)).toBeNull();
    expect(getImageBytes(remote, 1)).toBeNull();
    expect(getImageBytes(remote, 5)).toBeNull();
  });
});
