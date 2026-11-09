#!/usr/bin/env node
/**
 * Generates the glTF and GLB fixtures under fixtures/.
 *
 * Everything is procedural and deterministic: meshes come from parametric
 * formulas, PNG textures are encoded by hand (stored deflate blocks, so the
 * output does not depend on the zlib version), and no network is used.
 * This script deliberately does not import the library, so the tests check the
 * parser against files it did not produce.
 *
 *   node scripts/generate-fixtures.mjs           write fixtures/
 *   node scripts/generate-fixtures.mjs --check   fail if fixtures/ differs from what this script produces
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'fixtures');

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

// ---------------------------------------------------------------- binary helpers

function f32(values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return out;
}

function u16(values) {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint16(i * 2, v, true));
  return out;
}

function u32(values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v, true));
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const pad4 = (n) => (4 - (n % 4)) % 4;

function boundsOf(values, components) {
  const min = new Array(components).fill(Infinity);
  const max = new Array(components).fill(-Infinity);
  for (let i = 0; i < values.length; i += components) {
    for (let k = 0; k < components; k++) {
      const v = Math.fround(values[i + k]);
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function be32(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function pngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const body = concat([typeBytes, data]);
  return concat([be32(data.byteLength), body, be32(crc32(body))]);
}

/** zlib stream made only of stored (uncompressed) blocks. Valid, deterministic, a little large. */
function zlibStored(raw) {
  const parts = [new Uint8Array([0x78, 0x01])];
  for (let start = 0; start < raw.byteLength || start === 0; start += 65535) {
    const block = raw.subarray(start, Math.min(start + 65535, raw.byteLength));
    const last = start + 65535 >= raw.byteLength ? 1 : 0;
    const len = block.byteLength;
    parts.push(new Uint8Array([last, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff]), block);
    if (last) break;
  }
  parts.push(be32(adler32(raw)));
  return concat(parts);
}

/** `pixel(x, y)` returns [r, g, b] or [r, g, b, a], each 0 to 255. */
function encodePng(width, height, channels, pixel) {
  const rowBytes = width * channels;
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      for (let k = 0; k < channels; k++) raw[rowStart + 1 + x * channels + k] = p[k];
    }
  }
  const header = concat([be32(width), be32(height), new Uint8Array([8, channels === 4 ? 6 : 2, 0, 0, 0])]);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlibStored(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

function baseColorTexture() {
  return encodePng(64, 64, 4, (x, y) => {
    const odd = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 1;
    const shade = 0.75 + 0.25 * (y / 63);
    return odd ? [clamp8(200 * shade), clamp8(90 * shade), clamp8(40 * shade), 255] : [clamp8(235 * shade), clamp8(225 * shade), clamp8(200 * shade), 255];
  });
}

/** glTF packs occlusion (R), roughness (G) and metalness (B) into one texture. */
function ormTexture() {
  return encodePng(32, 32, 3, (x, y) => [255, clamp8(80 + (175 * x) / 31), clamp8((255 * y) / 31)]);
}

function normalTexture() {
  const height = (x, y) => 0.5 * Math.sin(x * 0.6) * Math.sin(y * 0.6);
  return encodePng(32, 32, 3, (x, y) => {
    const dx = height(x + 1, y) - height(x - 1, y);
    const dy = height(x, y + 1) - height(x, y - 1);
    const len = Math.hypot(dx, dy, 1);
    return [clamp8(((-dx / len) * 0.5 + 0.5) * 255), clamp8(((-dy / len) * 0.5 + 0.5) * 255), clamp8(((1 / len) * 0.5 + 0.5) * 255)];
  });
}

// ---------------------------------------------------------------- meshes

/** UV sphere. Pole rows get one triangle per segment instead of a degenerate pair. */
function uvSphere(radius, segments, rings) {
  const positions = [];
  const normals = [];
  const uvs = [];
  for (let i = 0; i <= rings; i++) {
    const v = i / rings;
    const theta = v * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const u = j / segments;
      const phi = u * Math.PI * 2;
      const nx = Math.sin(theta) * Math.cos(phi);
      const ny = Math.cos(theta);
      const nz = Math.sin(theta) * Math.sin(phi);
      positions.push(radius * nx, radius * ny, radius * nz);
      normals.push(nx, ny, nz);
      uvs.push(u, v);
    }
  }
  const indices = [];
  const stride = segments + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * stride + j;
      const b = a + stride;
      if (i !== 0) indices.push(a, b, a + 1);
      if (i !== rings - 1) indices.push(a + 1, b, b + 1);
    }
  }
  return { positions, normals, uvs, indices };
}

function torus(majorRadius, minorRadius, majorSegments, minorSegments) {
  const positions = [];
  const normals = [];
  const uvs = [];
  for (let i = 0; i <= majorSegments; i++) {
    const u = i / majorSegments;
    const phi = u * Math.PI * 2;
    for (let j = 0; j <= minorSegments; j++) {
      const v = j / minorSegments;
      const theta = v * Math.PI * 2;
      const nx = Math.cos(theta) * Math.cos(phi);
      const ny = Math.sin(theta);
      const nz = Math.cos(theta) * Math.sin(phi);
      positions.push((majorRadius + minorRadius * Math.cos(theta)) * Math.cos(phi), minorRadius * Math.sin(theta), (majorRadius + minorRadius * Math.cos(theta)) * Math.sin(phi));
      normals.push(nx, ny, nz);
      uvs.push(u, v);
    }
  }
  const indices = [];
  const stride = minorSegments + 1;
  for (let i = 0; i < majorSegments; i++) {
    for (let j = 0; j < minorSegments; j++) {
      const a = i * stride + j;
      const b = a + stride;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { positions, normals, uvs, indices };
}

/** Box with 24 vertices so every face has its own normals and UVs. */
function box(w, h, d) {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  const faces = [
    { n: [0, 0, 1], v: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
    { n: [0, 0, -1], v: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
    { n: [1, 0, 0], v: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
    { n: [-1, 0, 0], v: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    { n: [0, 1, 0], v: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { n: [0, -1, 0], v: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
  ];
  const corner = [[0, 1], [1, 1], [1, 0], [0, 0]];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  faces.forEach((face, f) => {
    face.v.forEach((p, k) => {
      positions.push(...p);
      normals.push(...face.n);
      uvs.push(...corner[k]);
    });
    const base = f * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return { positions, normals, uvs, indices };
}

// ---------------------------------------------------------------- glTF builder

class Builder {
  constructor(generatorNote) {
    this.json = { asset: { version: '2.0', generator: generatorNote } };
    this.parts = [];
    this.length = 0;
  }

  /** Appends bytes to the single buffer, 4-byte aligned, and returns the bufferView index. */
  view(bytes, { target, stride } = {}) {
    const padding = pad4(this.length);
    if (padding > 0) {
      this.parts.push(new Uint8Array(padding));
      this.length += padding;
    }
    const view = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength };
    if (stride !== undefined) view.byteStride = stride;
    if (target !== undefined) view.target = target;
    this.parts.push(bytes);
    this.length += bytes.byteLength;
    (this.json.bufferViews ??= []).push(view);
    return this.json.bufferViews.length - 1;
  }

  accessor(fields) {
    (this.json.accessors ??= []).push(fields);
    return this.json.accessors.length - 1;
  }

  add(key, value) {
    (this.json[key] ??= []).push(value);
    return this.json[key].length - 1;
  }

  /** Adds a mesh primitive with tightly packed attributes. */
  packedMesh(geometry, { indexType, material, name }) {
    const positions = Float32Array.from(geometry.positions);
    const { min, max } = boundsOf(positions, 3);
    const count = positions.length / 3;
    const position = this.accessor({ bufferView: this.view(f32(positions), { target: ARRAY_BUFFER }), componentType: FLOAT, count, type: 'VEC3', min, max });
    const normal = this.accessor({ bufferView: this.view(f32(geometry.normals), { target: ARRAY_BUFFER }), componentType: FLOAT, count, type: 'VEC3' });
    const uv = this.accessor({ bufferView: this.view(f32(geometry.uvs), { target: ARRAY_BUFFER }), componentType: FLOAT, count, type: 'VEC2' });
    const encoded = indexType === UNSIGNED_INT ? u32(geometry.indices) : u16(geometry.indices);
    const indices = this.accessor({ bufferView: this.view(encoded, { target: ELEMENT_ARRAY_BUFFER }), componentType: indexType, count: geometry.indices.length, type: 'SCALAR' });
    const primitive = { attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, indices, mode: 4 };
    if (material !== undefined) primitive.material = material;
    return this.add('meshes', { name, primitives: [primitive] });
  }

  /** Adds a mesh whose position, normal and UV share one interleaved bufferView (stride 32). */
  interleavedMesh(geometry, { material, name }) {
    const count = geometry.positions.length / 3;
    const packed = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) {
      packed.set(geometry.positions.slice(i * 3, i * 3 + 3), i * 8);
      packed.set(geometry.normals.slice(i * 3, i * 3 + 3), i * 8 + 3);
      packed.set(geometry.uvs.slice(i * 2, i * 2 + 2), i * 8 + 6);
    }
    const { min, max } = boundsOf(geometry.positions, 3);
    const view = this.view(f32(packed), { target: ARRAY_BUFFER, stride: 32 });
    const position = this.accessor({ bufferView: view, byteOffset: 0, componentType: FLOAT, count, type: 'VEC3', min, max });
    const normal = this.accessor({ bufferView: view, byteOffset: 12, componentType: FLOAT, count, type: 'VEC3' });
    const uv = this.accessor({ bufferView: view, byteOffset: 24, componentType: FLOAT, count, type: 'VEC2' });
    const indices = this.accessor({ bufferView: this.view(u16(geometry.indices), { target: ELEMENT_ARRAY_BUFFER }), componentType: UNSIGNED_SHORT, count: geometry.indices.length, type: 'SCALAR' });
    return this.add('meshes', { name, primitives: [{ attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, indices, material, mode: 4 }] });
  }

  bin() {
    const padding = pad4(this.length);
    return concat(padding > 0 ? [...this.parts, new Uint8Array(padding)] : this.parts);
  }
}

function glb(json, bin) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = concat([jsonBytes, new Uint8Array(pad4(jsonBytes.byteLength)).fill(0x20)]);
  const binPadded = concat([bin, new Uint8Array(pad4(bin.byteLength))]);
  const total = 12 + 8 + jsonPadded.byteLength + 8 + binPadded.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonPadded, 20);
  const binStart = 20 + jsonPadded.byteLength;
  view.setUint32(binStart, binPadded.byteLength, true);
  view.setUint32(binStart + 4, 0x004e4942, true);
  out.set(binPadded, binStart + 8);
  return out;
}

const gltfText = (json) => new TextEncoder().encode(`${JSON.stringify(json, null, 2)}\n`);
const dataUri = (bytes) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
const GENERATOR = 'gltf-forge fixture generator';

// ---------------------------------------------------------------- fixtures

function sphereFixture(files) {
  const b = new Builder(GENERATOR);
  b.add('materials', { name: 'Clay', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.35, 0.3, 1], metallicFactor: 0, roughnessFactor: 0.7 } });
  const mesh = b.packedMesh(uvSphere(0.5, 32, 16), { indexType: UNSIGNED_SHORT, material: 0, name: 'Sphere' });
  b.add('nodes', { name: 'Sphere', mesh });
  b.add('scenes', { name: 'Scene', nodes: [0] });
  b.json.scene = 0;
  const bin = b.bin();

  files.set('sphere.glb', glb({ ...b.json, buffers: [{ byteLength: bin.byteLength }] }, bin));
  files.set('sphere.bin', bin);
  files.set('sphere.gltf', gltfText({ ...b.json, buffers: [{ uri: 'sphere.bin', byteLength: bin.byteLength }] }));
}

function torusFixture(files) {
  const b = new Builder(GENERATOR);
  b.add('materials', { name: 'Brass', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.7, 0.3, 1], metallicFactor: 1, roughnessFactor: 0.3 } });
  // 32-bit indices on purpose, so the fixtures cover both index widths.
  const mesh = b.packedMesh(torus(0.5, 0.18, 48, 24), { indexType: UNSIGNED_INT, material: 0, name: 'Torus' });
  b.add('nodes', { name: 'Torus', mesh });
  b.add('scenes', { name: 'Scene', nodes: [0] });
  b.json.scene = 0;
  const bin = b.bin();

  files.set('torus.glb', glb({ ...b.json, buffers: [{ byteLength: bin.byteLength }] }, bin));
  files.set('torus.gltf', gltfText({ ...b.json, buffers: [{ uri: dataUri(bin), byteLength: bin.byteLength }] }));
}

function texturedCubeFixture(files) {
  const textures = {
    baseColor: baseColorTexture(),
    orm: ormTexture(),
    normal: normalTexture(),
  };

  const build = (embedImages) => {
    const b = new Builder(GENERATOR);
    const mesh = b.interleavedMesh(box(1, 1, 1), { material: 0, name: 'Crate' });
    b.add('samplers', { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
    const sources = [
      ['crate_basecolor', 'textures/crate-basecolor.png', textures.baseColor],
      ['crate_orm', 'textures/crate-orm.png', textures.orm],
      ['crate_normal', 'textures/crate-normal.png', textures.normal],
    ];
    sources.forEach(([name, uri, bytes], i) => {
      b.add('images', embedImages ? { name, mimeType: 'image/png', bufferView: b.view(bytes) } : { name, mimeType: 'image/png', uri });
      b.add('textures', { sampler: 0, source: i });
    });
    b.add('materials', {
      name: 'Crate',
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 }, metallicFactor: 1, roughnessFactor: 1 },
      normalTexture: { index: 2, scale: 1 },
      occlusionTexture: { index: 1 },
    });
    b.add('nodes', { name: 'Crate', mesh });
    b.add('scenes', { name: 'Scene', nodes: [0] });
    b.json.scene = 0;
    return b;
  };

  const embedded = build(true);
  const embeddedBin = embedded.bin();
  files.set('textured-cube.glb', glb({ ...embedded.json, buffers: [{ byteLength: embeddedBin.byteLength }] }, embeddedBin));

  const external = build(false);
  const externalBin = external.bin();
  files.set('textured-cube.gltf', gltfText({ ...external.json, buffers: [{ uri: 'textured-cube.bin', byteLength: externalBin.byteLength }] }));
  files.set('textured-cube.bin', externalBin);
  files.set('textures/crate-basecolor.png', textures.baseColor);
  files.set('textures/crate-orm.png', textures.orm);
  files.set('textures/crate-normal.png', textures.normal);
}

/** One root, seven groups, six instances in each group: 1 + 7 + 42 = 50 nodes, two shared meshes. */
function scene50Fixture(files) {
  const b = new Builder(GENERATOR);
  b.add('materials', { name: 'Grey', pbrMetallicRoughness: { baseColorFactor: [0.6, 0.6, 0.65, 1], metallicFactor: 0, roughnessFactor: 0.9 } });
  const cube = b.packedMesh(box(0.4, 0.4, 0.4), { indexType: UNSIGNED_SHORT, material: 0, name: 'Block' });
  const ball = b.packedMesh(uvSphere(0.25, 16, 8), { indexType: UNSIGNED_SHORT, material: 0, name: 'Ball' });

  const nodes = [{ name: 'Root', children: [] }];
  for (let g = 0; g < 7; g++) {
    const angle = (g / 7) * Math.PI * 2;
    const group = { name: `Group ${g}`, translation: [Math.cos(angle) * 4, 0, Math.sin(angle) * 4], children: [] };
    const groupIndex = nodes.push(group) - 1;
    nodes[0].children.push(groupIndex);
    for (let k = 0; k < 6; k++) {
      const half = Math.sin((k * 0.4) / 2);
      const leaf = {
        name: `Item ${g}.${k}`,
        mesh: (g + k) % 2 === 0 ? cube : ball,
        translation: [(k % 3) - 1, Math.floor(k / 3) * 0.8, 0],
        rotation: [0, Math.fround(half), 0, Math.fround(Math.cos((k * 0.4) / 2))],
        scale: [1 + k * 0.1, 1, 1 + k * 0.1],
      };
      group.children.push(nodes.push(leaf) - 1);
    }
  }
  b.json.nodes = nodes;
  b.add('scenes', { name: 'Scene', nodes: [0] });
  b.json.scene = 0;
  const bin = b.bin();
  files.set('scene-50-nodes.glb', glb({ ...b.json, buffers: [{ byteLength: bin.byteLength }] }, bin));
}

/** Builds every fixture in memory. Keys are paths relative to fixtures/. */
export function buildFixtures() {
  const files = new Map();
  sphereFixture(files);
  torusFixture(files);
  texturedCubeFixture(files);
  scene50Fixture(files);
  return files;
}

async function main() {
  const files = buildFixtures();
  if (process.argv.includes('--check')) {
    const stale = [];
    for (const [name, bytes] of files) {
      const onDisk = await readFile(join(outDir, name)).catch(() => null);
      if (onDisk === null) stale.push(`${name} (missing)`);
      else if (!Buffer.from(bytes).equals(onDisk)) stale.push(`${name} (differs)`);
    }
    if (stale.length > 0) {
      console.error(`fixtures are out of date: ${stale.join(', ')}\nRun "npm run fixtures" and commit the result.`);
      process.exit(1);
    }
    console.log(`${files.size} fixtures match the generator.`);
    return;
  }
  for (const [name, bytes] of files) {
    const target = join(outDir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    console.log(`${name}  ${bytes.byteLength} bytes`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
