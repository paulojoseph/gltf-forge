import { assetByteLength, type Asset } from './gltf/asset.js';
import { getImageBytes, readImageInfo } from './gltf/image-info.js';
import type { GltfMaterial, GltfPrimitive } from './gltf/types.js';
import { classifyUri } from './gltf/uri.js';

export type ByteCategory = 'vertexAttributes' | 'indices' | 'images' | 'animation' | 'skinning' | 'other';

const CATEGORY_ORDER: ByteCategory[] = ['vertexAttributes', 'indices', 'images', 'animation', 'skinning', 'other'];

const CATEGORY_LABEL: Record<ByteCategory, string> = {
  vertexAttributes: 'vertex attributes',
  indices: 'indices',
  images: 'embedded images',
  animation: 'animation',
  skinning: 'skinning',
  other: 'other accessors',
};

const MODE_NAME = ['POINTS', 'LINES', 'LINE_LOOP', 'LINE_STRIP', 'TRIANGLES', 'TRIANGLE_STRIP', 'TRIANGLE_FAN'];

export interface PrimitiveReport {
  mode: string;
  vertices: number;
  /** Entries in the index accessor, or null when the primitive is not indexed. */
  indices: number | null;
  triangles: number;
  material: number | null;
}

export interface MeshReport {
  index: number;
  name: string | null;
  primitives: PrimitiveReport[];
  vertices: number;
  triangles: number;
  /** Nodes that draw this mesh in the default scene. */
  instances: number;
  /** `triangles * instances`: what the GPU is asked to draw for this mesh. */
  drawnTriangles: number;
}

export interface ImageReport {
  index: number;
  name: string | null;
  source: 'bufferView' | 'data-uri' | 'file' | 'remote' | 'missing';
  /** The URI as written, shortened for data URIs. Null for images stored in a bufferView. */
  uri: string | null;
  mimeType: string | null;
  format: 'png' | 'jpeg' | 'ktx2' | null;
  width: number | null;
  height: number | null;
  /** Size of the encoded file in bytes. */
  encodedBytes: number | null;
  /**
   * Estimated video memory after the browser decodes it: RGBA8 with a full mip
   * chain. Null for formats the GPU keeps compressed (KTX2) or when the size is unknown.
   */
  gpuBytes: number | null;
  usedBy: string[];
}

export interface BufferReport {
  index: number;
  source: 'glb-bin' | 'file' | 'data-uri' | 'remote' | 'missing';
  uri: string | null;
  declaredBytes: number;
  availableBytes: number | null;
  views: number;
  /** Declared bytes per use. A byte that several views cover is counted once, under the first category that claims it. */
  categories: Record<ByteCategory, number>;
  /** Bytes covered by a bufferView that nothing refers to. */
  unusedViews: number;
  /** Bytes outside every bufferView, such as alignment padding. */
  gaps: number;
}

export interface InspectReport {
  file: { name: string | null; format: 'gltf' | 'glb'; bytes: number };
  generator: string | null;
  version: string | null;
  extensionsUsed: string[];
  extensionsRequired: string[];
  defaultScene: number | null;
  counts: Record<
    'scenes' | 'nodes' | 'meshes' | 'materials' | 'textures' | 'images' | 'animations' | 'skins' | 'cameras' | 'accessors' | 'bufferViews' | 'buffers',
    number
  >;
  meshes: MeshReport[];
  totals: { vertices: number; triangles: number; drawnTriangles: number };
  images: ImageReport[];
  buffers: BufferReport[];
}

export interface InspectOptions {
  /** Shown in the report header, usually the file name. */
  name?: string;
}

function trianglesFor(mode: number, count: number): number {
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function sizeOf(asset: Asset, accessor: number | undefined): number {
  if (accessor === undefined) return 0;
  const count = asset.json.accessors?.[accessor]?.count;
  return typeof count === 'number' ? count : 0;
}

function describePrimitive(asset: Asset, primitive: GltfPrimitive): PrimitiveReport {
  const mode = primitive.mode ?? 4;
  const vertices = sizeOf(asset, primitive.attributes.POSITION);
  const indices = primitive.indices === undefined ? null : sizeOf(asset, primitive.indices);
  return {
    mode: MODE_NAME[mode] ?? `MODE_${mode}`,
    vertices,
    indices,
    triangles: trianglesFor(mode, indices ?? vertices),
    material: primitive.material ?? null,
  };
}

function countInstances(asset: Asset): number[] {
  const meshes = asset.json.meshes ?? [];
  const nodes = asset.json.nodes ?? [];
  const instances = new Array<number>(meshes.length).fill(0);
  const scenes = asset.json.scenes ?? [];
  let reachable: Iterable<number>;
  if (scenes.length === 0) {
    reachable = nodes.keys();
  } else {
    const seen = new Set<number>();
    const stack = [...(scenes[asset.json.scene ?? 0]?.nodes ?? [])];
    while (stack.length > 0) {
      const index = stack.pop();
      if (index === undefined || seen.has(index)) continue;
      seen.add(index);
      stack.push(...(nodes[index]?.children ?? []));
    }
    reachable = seen;
  }
  for (const index of reachable) {
    const mesh = nodes[index]?.mesh;
    if (mesh !== undefined && instances[mesh] !== undefined) instances[mesh] = (instances[mesh] ?? 0) + 1;
  }
  return instances;
}

/** Image slots of a material and the texture each one points at. */
function materialTextures(material: GltfMaterial): [string, number | undefined][] {
  const pbr = material.pbrMetallicRoughness;
  return [
    ['baseColor', pbr?.baseColorTexture?.index],
    ['metallicRoughness', pbr?.metallicRoughnessTexture?.index],
    ['normal', material.normalTexture?.index],
    ['occlusion', material.occlusionTexture?.index],
    ['emissive', material.emissiveTexture?.index],
  ];
}

function gpuBytesFor(width: number, height: number): number {
  let total = 0;
  let w = width;
  let h = height;
  for (;;) {
    total += w * h * 4;
    if (w === 1 && h === 1) return total;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
}

function describeImages(asset: Asset): ImageReport[] {
  const usage = new Map<number, string[]>();
  (asset.json.materials ?? []).forEach((material, m) => {
    for (const [slot, texture] of materialTextures(material)) {
      if (texture === undefined) continue;
      const source = asset.json.textures?.[texture]?.source;
      if (source === undefined) continue;
      usage.set(source, [...(usage.get(source) ?? []), `materials[${m}].${slot}`]);
    }
  });

  return (asset.json.images ?? []).map((image, index): ImageReport => {
    let source: ImageReport['source'] = 'missing';
    let uri: string | null = null;
    if (typeof image.uri === 'string') {
      const kind = classifyUri(image.uri);
      source = kind === 'data' ? 'data-uri' : kind === 'remote' ? 'remote' : 'file';
      uri = kind === 'data' ? `${image.uri.slice(0, image.uri.indexOf(',') + 1)}...` : image.uri;
    } else if (image.bufferView !== undefined) {
      source = 'bufferView';
    }

    let bytes: Uint8Array | null;
    try {
      bytes = getImageBytes(asset, index);
    } catch {
      bytes = null;
    }
    if (bytes === null && (source === 'file' || source === 'data-uri')) source = 'missing';
    const info = bytes === null ? null : readImageInfo(bytes);
    const gpu = info !== null && info.format !== 'ktx2' && info.width > 0 && info.height > 0 ? gpuBytesFor(info.width, info.height) : null;
    return {
      index,
      name: image.name ?? null,
      source,
      uri,
      mimeType: image.mimeType ?? null,
      format: info?.format ?? null,
      width: info?.width ?? null,
      height: info?.height ?? null,
      encodedBytes: bytes?.byteLength ?? null,
      gpuBytes: gpu,
      usedBy: usage.get(index) ?? [],
    };
  });
}

type Interval = [number, number];

/** Adds [start, end) to `claimed` (sorted, non-overlapping) and returns how many of its bytes were not claimed yet. */
function claim(claimed: Interval[], start: number, end: number): number {
  if (end <= start) return 0;
  let overlap = 0;
  let mergedStart = start;
  let mergedEnd = end;
  const rest: Interval[] = [];
  for (const [s, e] of claimed) {
    if (e < start || s > end) {
      rest.push([s, e]);
      continue;
    }
    overlap += Math.max(0, Math.min(e, end) - Math.max(s, start));
    mergedStart = Math.min(mergedStart, s);
    mergedEnd = Math.max(mergedEnd, e);
  }
  rest.push([mergedStart, mergedEnd]);
  rest.sort((a, b) => a[0] - b[0]);
  claimed.splice(0, claimed.length, ...rest);
  return end - start - overlap;
}

function describeBuffers(asset: Asset): BufferReport[] {
  const json = asset.json;
  const views = json.bufferViews ?? [];
  const accessors = json.accessors ?? [];

  // Which categories reference each bufferView.
  const usedAs = new Map<number, Set<ByteCategory>>();
  const mark = (view: number | undefined, category: ByteCategory): void => {
    if (view === undefined || views[view] === undefined) return;
    const set = usedAs.get(view) ?? new Set<ByteCategory>();
    set.add(category);
    usedAs.set(view, set);
  };
  const accessorUse = new Map<number, ByteCategory>();
  const tag = (accessor: number | undefined, category: ByteCategory): void => {
    if (accessor === undefined) return;
    const current = accessorUse.get(accessor);
    if (current === undefined || CATEGORY_ORDER.indexOf(category) < CATEGORY_ORDER.indexOf(current)) accessorUse.set(accessor, category);
  };
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      Object.values(primitive.attributes).forEach((a) => tag(a, 'vertexAttributes'));
      tag(primitive.indices, 'indices');
      for (const target of primitive.targets ?? []) Object.values(target).forEach((a) => tag(a, 'vertexAttributes'));
    }
  }
  for (const animation of json.animations ?? []) {
    for (const sampler of animation.samplers) {
      tag(sampler.input, 'animation');
      tag(sampler.output, 'animation');
    }
  }
  for (const skin of json.skins ?? []) tag(skin.inverseBindMatrices, 'skinning');
  accessors.forEach((accessor, index) => {
    const category = accessorUse.get(index) ?? 'other';
    mark(accessor.bufferView, category);
    mark(accessor.sparse?.indices.bufferView, 'other');
    mark(accessor.sparse?.values.bufferView, 'other');
  });
  for (const image of json.images ?? []) mark(image.bufferView, 'images');

  return (json.buffers ?? []).map((buffer, index): BufferReport => {
    const data = asset.buffers[index] ?? null;
    let source: BufferReport['source'] = 'missing';
    let uri: string | null = null;
    if (typeof buffer.uri === 'string') {
      const kind = classifyUri(buffer.uri);
      source = kind === 'data' ? 'data-uri' : kind === 'remote' ? 'remote' : data === null ? 'missing' : 'file';
      uri = kind === 'data' ? `${buffer.uri.slice(0, buffer.uri.indexOf(',') + 1)}...` : buffer.uri;
    } else if (asset.format === 'glb' && index === 0 && data !== null) {
      source = 'glb-bin';
    }

    const declared = buffer.byteLength;
    const categories: Record<ByteCategory, number> = { vertexAttributes: 0, indices: 0, images: 0, animation: 0, skinning: 0, other: 0 };
    const mine = views.map((view, i) => ({ view, i })).filter(({ view }) => view.buffer === index);
    const claimed: Interval[] = [];
    for (const category of CATEGORY_ORDER) {
      for (const { view, i } of mine) {
        const set = usedAs.get(i);
        const owner = set === undefined ? undefined : CATEGORY_ORDER.find((c) => set.has(c));
        if (owner !== category) continue;
        const start = Math.min(view.byteOffset ?? 0, declared);
        const end = Math.min(start + view.byteLength, declared);
        categories[category] += claim(claimed, start, end);
      }
    }
    let unusedViews = 0;
    for (const { view, i } of mine) {
      if (usedAs.has(i)) continue;
      const start = Math.min(view.byteOffset ?? 0, declared);
      unusedViews += claim(claimed, start, Math.min(start + view.byteLength, declared));
    }
    const covered = claimed.reduce((sum, [s, e]) => sum + (e - s), 0);
    return {
      index,
      source,
      uri,
      declaredBytes: declared,
      availableBytes: data?.byteLength ?? null,
      views: mine.length,
      categories,
      unusedViews,
      gaps: Math.max(0, declared - covered),
    };
  });
}

/**
 * Summarizes an asset: triangle counts per mesh, image sizes, and where the bytes
 * of every buffer go. It trusts the asset's structure; run `validate()` first on
 * files you do not control, since a broken asset can make this throw.
 */
export function inspectAsset(asset: Asset, options: InspectOptions = {}): InspectReport {
  const json = asset.json;
  const instances = countInstances(asset);
  const meshes = (json.meshes ?? []).map((mesh, index): MeshReport => {
    const primitives = mesh.primitives.map((p) => describePrimitive(asset, p));
    const triangles = primitives.reduce((sum, p) => sum + p.triangles, 0);
    const count = instances[index] ?? 0;
    return {
      index,
      name: mesh.name ?? null,
      primitives,
      vertices: primitives.reduce((sum, p) => sum + p.vertices, 0),
      triangles,
      instances: count,
      drawnTriangles: triangles * count,
    };
  });

  const length = (list: unknown[] | undefined): number => list?.length ?? 0;
  return {
    file: { name: options.name ?? null, format: asset.format, bytes: assetByteLength(asset) },
    generator: json.asset.generator ?? null,
    version: json.asset.version,
    extensionsUsed: json.extensionsUsed ?? [],
    extensionsRequired: json.extensionsRequired ?? [],
    defaultScene: json.scenes === undefined || json.scenes.length === 0 ? null : (json.scene ?? 0),
    counts: {
      scenes: length(json.scenes),
      nodes: length(json.nodes),
      meshes: length(json.meshes),
      materials: length(json.materials),
      textures: length(json.textures),
      images: length(json.images),
      animations: length(json.animations),
      skins: length(json.skins),
      cameras: length(json.cameras),
      accessors: length(json.accessors),
      bufferViews: length(json.bufferViews),
      buffers: length(json.buffers),
    },
    meshes,
    totals: {
      vertices: meshes.reduce((sum, m) => sum + m.vertices, 0),
      triangles: meshes.reduce((sum, m) => sum + m.triangles, 0),
      drawnTriangles: meshes.reduce((sum, m) => sum + m.drawnTriangles, 0),
    },
    images: describeImages(asset),
    buffers: describeBuffers(asset),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

const number = (n: number): string => n.toLocaleString('en-US');

function table(header: string[], rows: string[][], align: ('l' | 'r')[]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    '  ' +
    cells
      .map((cell, i) => (align[i] === 'r' ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

function storedIn(image: ImageReport): string {
  switch (image.source) {
    case 'bufferView':
      return 'in buffer';
    case 'file':
      return image.uri ?? 'file';
    case 'data-uri':
      return 'data URI';
    case 'remote':
      return `remote ${image.uri ?? ''}`.trimEnd();
    case 'missing':
      return 'missing';
  }
}

/** Renders a report as plain text for a terminal. */
export function formatReport(report: InspectReport): string {
  const out: string[] = [];
  const { file, counts } = report;
  out.push(`${file.name ?? 'asset'}  (${file.format === 'glb' ? 'GLB' : 'glTF'} ${report.version ?? '?'}, ${formatBytes(file.bytes)} on disk)`);
  if (report.generator !== null) out.push(`generator: ${report.generator}`);
  if (report.extensionsUsed.length > 0) out.push(`extensions: ${report.extensionsUsed.join(', ')}${report.extensionsRequired.length > 0 ? ` (required: ${report.extensionsRequired.join(', ')})` : ''}`);
  out.push(
    `scenes ${counts.scenes}, nodes ${counts.nodes}, meshes ${counts.meshes}, materials ${counts.materials}, textures ${counts.textures}, images ${counts.images}, animations ${counts.animations}, skins ${counts.skins}`,
  );

  out.push('', 'Meshes');
  if (report.meshes.length === 0) {
    out.push('  none');
  } else {
    out.push(
      ...table(
        ['#', 'name', 'prims', 'vertices', 'triangles', 'instances', 'drawn'],
        report.meshes.map((m) => [String(m.index), m.name ?? '-', String(m.primitives.length), number(m.vertices), number(m.triangles), String(m.instances), number(m.drawnTriangles)]),
        ['r', 'l', 'r', 'r', 'r', 'r', 'r'],
      ),
    );
    out.push(`  total: ${number(report.totals.triangles)} triangles stored, ${number(report.totals.drawnTriangles)} drawn from the default scene`);
  }

  out.push('', 'Textures');
  if (report.images.length === 0) {
    out.push('  none');
  } else {
    out.push(
      ...table(
        ['#', 'name', 'size', 'format', 'stored', 'encoded', 'gpu (est.)', 'used by'],
        report.images.map((image) => [
          String(image.index),
          image.name ?? '-',
          image.width === null || image.height === null ? '?' : `${image.width}x${image.height}`,
          image.format ?? image.mimeType ?? '?',
          storedIn(image),
          image.encodedBytes === null ? '?' : formatBytes(image.encodedBytes),
          image.gpuBytes === null ? '-' : formatBytes(image.gpuBytes),
          image.usedBy.join(', ') || '-',
        ]),
        ['r', 'l', 'r', 'l', 'l', 'r', 'r', 'l'],
      ),
    );
    out.push('  gpu (est.) assumes RGBA8 with a full mip chain, the usual cost once a browser has decoded the image.');
  }

  out.push('', 'Buffers');
  if (report.buffers.length === 0) {
    out.push('  none');
  }
  for (const buffer of report.buffers) {
    const where = buffer.source === 'glb-bin' ? 'GLB BIN chunk' : buffer.source === 'data-uri' ? 'embedded data URI' : buffer.uri === null ? buffer.source : `${buffer.uri} (${buffer.source})`;
    out.push(`  [${buffer.index}] ${where}, ${number(buffer.declaredBytes)} B declared in ${buffer.views} bufferViews`);
    const rows: [string, number][] = CATEGORY_ORDER.map((c): [string, number] => [CATEGORY_LABEL[c], buffer.categories[c]]);
    rows.push(['unused bufferViews', buffer.unusedViews], ['gaps and padding', buffer.gaps]);
    for (const [label, bytes] of rows) {
      if (bytes === 0) continue;
      const share = buffer.declaredBytes === 0 ? 0 : (bytes / buffer.declaredBytes) * 100;
      out.push(`      ${label.padEnd(18)} ${number(bytes).padStart(10)} B  ${share.toFixed(1).padStart(5)}%`);
    }
    if (buffer.availableBytes !== null && buffer.availableBytes !== buffer.declaredBytes) {
      out.push(`      note: ${number(buffer.availableBytes)} B are available but ${number(buffer.declaredBytes)} B are declared`);
    }
  }
  return out.join('\n');
}
