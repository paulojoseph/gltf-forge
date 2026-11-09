import { describe, expect, it } from 'vitest';
import { parseAsset, validate, type Asset, type Issue, type IssueCode } from '../src/index.js';
import { FIXTURE_ASSETS, loadFixture, loadGlb, makeGlb, mutated, patchedGlb, setU16, setU32 } from './helpers.js';

function only(asset: Asset, code: IssueCode): Issue {
  const found = validate(asset).issues.filter((issue) => issue.code === code);
  expect(found, `expected exactly one ${code} issue`).toHaveLength(1);
  return found[0];
}

function codes(asset: Asset): IssueCode[] {
  return validate(asset).issues.map((issue) => issue.code);
}

describe('validate on good files', () => {
  it.each(FIXTURE_ASSETS)('finds nothing to report in %s', async (name) => {
    const result = validate(await loadFixture(name));
    expect(result.issues).toEqual([]);
    expect(result).toMatchObject({ ok: true, errors: 0, warnings: 0 });
  });
});

describe('asset and extensions', () => {
  it('requires asset.version', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      delete (json.asset as Partial<typeof json.asset>).version;
    });
    expect(only(asset, 'ASSET_VERSION')).toMatchObject({ severity: 'error', path: '/asset/version', location: 'asset.version' });
  });

  it('rejects another major version and a minVersion above 2.0', () => {
    expect(only(mutated(loadGlb('sphere.glb'), (json) => void (json.asset.version = '1.0')), 'ASSET_VERSION').message).toBe('asset.version is "1.0", but gltf-forge reads glTF 2.x only.');
    expect(only(mutated(loadGlb('sphere.glb'), (json) => void (json.asset.minVersion = '2.1')), 'ASSET_VERSION').message).toContain('newer than 2.0');
  });

  it('flags a required extension that is not listed as used', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      json.extensionsRequired = ['KHR_texture_transform'];
    });
    expect(only(asset, 'EXTENSION_NOT_USED').message).toBe('"KHR_texture_transform" is listed in extensionsRequired but not in extensionsUsed. Every required extension must also be listed as used.');
  });

  it('warns that compressed geometry is not checked, and skips the data checks', () => {
    const asset = patchedGlb('sphere.glb', (bin, json) => {
      json.extensionsUsed = ['KHR_draco_mesh_compression'];
      const view = json.bufferViews?.[3];
      setU16(bin, (view?.byteOffset ?? 0) + 4, 60000); // an index far past the 561 vertices
    });
    expect(validate(asset).issues.map((i) => [i.severity, i.code])).toEqual([['warning', 'EXTENSION_UNSUPPORTED']]);
  });
});

describe('references that point nowhere', () => {
  it('names the collection, the index and how many exist', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      const primitive = json.meshes?.[0]?.primitives[0];
      if (primitive) primitive.attributes.NORMAL = 99;
    });
    expect(only(asset, 'INDEX_OUT_OF_RANGE')).toMatchObject({
      severity: 'error',
      path: '/meshes/0/primitives/0/attributes/NORMAL',
      location: 'meshes[0].primitives[0].attributes.NORMAL',
      message: 'accessors[99] does not exist; the asset has 4 accessors.',
    });
  });

  it('says "no" rather than "0" when the collection is missing', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      delete json.materials;
    });
    expect(only(asset, 'INDEX_OUT_OF_RANGE').message).toBe('materials[0] does not exist; the asset has no materials.');
  });

  it.each([
    ['a negative index', -1],
    ['a fraction', 1.5],
    ['a string', '2'],
  ])('rejects %s as an index', (_name, value) => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      const node = json.nodes?.[0];
      if (node) node.mesh = value as number;
    });
    expect(only(asset, 'TYPE_MISMATCH').message).toContain('must be a non-negative integer index into meshes');
  });

  it('covers images, textures, materials, nodes, scenes and skins', async () => {
    const asset = mutated(await loadFixture('textured-cube.gltf'), (json) => {
      const [image] = json.images ?? [];
      const [texture] = json.textures ?? [];
      const [material] = json.materials ?? [];
      if (texture) {
        texture.source = 7;
        texture.sampler = 3;
      }
      if (image) image.name = 'x';
      if (material?.normalTexture) material.normalTexture.index = 12;
      json.scene = 4;
      json.scenes = [{ nodes: [9] }];
      json.nodes = [{ mesh: 0, skin: 2, camera: 1 }];
      json.skins = [{ joints: [5], skeleton: 6, inverseBindMatrices: 99 }];
    });
    const messages = validate(asset).issues.map((issue) => `${issue.location}: ${issue.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        'textures[0].source: images[7] does not exist; the asset has 3 images.',
        'textures[0].sampler: samplers[3] does not exist; the asset has 1 samplers.',
        'materials[0].normalTexture.index: textures[12] does not exist; the asset has 3 textures.',
        'nodes[0].skin: skins[2] does not exist; the asset has 1 skins.',
        'nodes[0].camera: cameras[1] does not exist; the asset has no cameras.',
        'skins[0].joints[0]: nodes[5] does not exist; the asset has 1 nodes.',
        'skins[0].skeleton: nodes[6] does not exist; the asset has 1 nodes.',
        'skins[0].inverseBindMatrices: accessors[99] does not exist; the asset has 4 accessors.',
        'scenes[0].nodes[0]: nodes[9] does not exist; the asset has 1 nodes.',
        'scene: scenes[4] does not exist; the asset has 1 scenes.',
      ]),
    );
  });
});

describe('buffers and bufferViews', () => {
  it('rejects a buffer that declares more bytes than the BIN chunk holds', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.buffers?.[0]) json.buffers[0].byteLength = 30000;
    });
    expect(only(asset, 'BUFFER_TOO_SHORT').message).toBe('buffers[0] declares 30000 bytes but the GLB BIN chunk only holds 23712.');
  });

  it('warns when the BIN chunk has more than 3 bytes of padding', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.buffers?.[0]) json.buffers[0].byteLength = 23000;
    });
    expect(only(asset, 'BUFFER_PADDING')).toMatchObject({ severity: 'warning' });
  });

  it('allows up to 3 bytes of BIN padding and warns from 4', () => {
    const glbWith = (declared: number): Asset => parseAsset(makeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: declared }] }, new Uint8Array(12)));
    expect(validate(glbWith(12)).issues).toEqual([]);
    expect(validate(glbWith(9)).issues).toEqual([]);
    expect(only(glbWith(8), 'BUFFER_PADDING').message).toBe('The GLB BIN chunk holds 12 bytes but buffers[0] declares 8. The spec allows at most 3 bytes of chunk padding.');
  });

  it('rejects a GLB whose first buffer has no uri but the file has no BIN chunk', () => {
    const asset = parseAsset(makeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 8 }] }));
    expect(only(asset, 'BUFFER_NO_DATA').message).toContain('the file has no BIN chunk');
  });

  it('rejects a second buffer without a uri', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      json.buffers?.push({ byteLength: 4 });
    });
    expect(only(asset, 'BUFFER_URI').message).toBe('buffers[1] has no uri. Only the first buffer of a GLB may omit it, and it then uses the BIN chunk.');
  });

  it('warns about a remote buffer instead of failing on it', () => {
    const asset = parseAsset(makeGlb({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.com/a.bin', byteLength: 8 }] }));
    expect(only(asset, 'BUFFER_REMOTE')).toMatchObject({ severity: 'warning', location: 'buffers[0].uri' });
  });

  it('catches an external file shorter than its declared length', async () => {
    const asset = mutated(await loadFixture('sphere.gltf'), (json) => {
      if (json.buffers?.[0]) json.buffers[0].byteLength = 99999;
    });
    expect(only(asset, 'BUFFER_TOO_SHORT').message).toBe('buffers[0] declares 99999 bytes but its data only has 23712.');
  });

  it('catches a bufferView that runs past the end of its buffer', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.bufferViews?.[3]) json.bufferViews[3].byteLength = 99999;
    });
    expect(only(asset, 'BUFFER_VIEW_RANGE').message).toBe('bufferViews[3] covers bytes 17952 to 117951 but buffers[0] is only 23712 bytes long.');
  });

  it.each([7, 2, 256])('rejects a byteStride of %i', (stride) => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.bufferViews?.[0]) json.bufferViews[0].byteStride = stride;
    });
    expect(codes(asset)).toContain('BUFFER_VIEW_STRIDE');
  });

  it('rejects an unknown bufferView target', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.bufferViews?.[0]) json.bufferViews[0].target = 1234;
    });
    expect(only(asset, 'TYPE_MISMATCH').message).toContain('34962 (ARRAY_BUFFER) or 34963');
  });
});

describe('accessors', () => {
  it('rejects an accessor that reads past its bufferView', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.accessors?.[0]) json.accessors[0].count = 600;
    });
    expect(only(asset, 'ACCESSOR_RANGE').message).toBe('accessors[0] needs 7200 bytes (600 elements of 12 bytes, stride 12) but bufferViews[0] is only 6732 bytes long.');
  });

  it('rejects a byteOffset that is not a multiple of the component size', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.accessors?.[1]) json.accessors[1].byteOffset = 2;
    });
    expect(only(asset, 'ACCESSOR_ALIGNMENT').message).toContain('is not a multiple of its 4-byte components');
  });

  it('accepts a byteStride equal to the element size', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.bufferViews?.[0]) json.bufferViews[0].byteStride = 12;
    });
    expect(validate(asset).issues).toEqual([]);
  });

  it('rejects an accessor that is misaligned only because its bufferView starts at an odd offset', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.bufferViews?.[1]) json.bufferViews[1].byteOffset = 6734;
    });
    expect(only(asset, 'ACCESSOR_ALIGNMENT').message).toContain('starts at byte 6734 of its buffer');
  });

  it('rejects elements that would overlap because the stride is smaller than the element', async () => {
    const asset = mutated(await loadFixture('textured-cube.gltf'), (json) => {
      if (json.bufferViews?.[0]) json.bufferViews[0].byteStride = 8;
    });
    expect(validate(asset).issues.map((i) => i.message)).toContain('Each element is 12 bytes, but bufferViews[0].byteStride is only 8, so elements would overlap.');
  });

  it.each([
    ['componentType', 5124, /componentType must be one of 5120, 5121, 5122, 5123, 5125 or 5126, found 5124/],
    ['type', 'VEC5', /type must be SCALAR, VEC2, VEC3, VEC4, MAT2, MAT3 or MAT4, found "VEC5"/],
    ['count', 0, /integer of at least 1, found 0/],
  ])('rejects an invalid %s', (key, value, message) => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.accessors?.[1]) (json.accessors[1] as unknown as Record<string, unknown>)[key] = value;
    });
    expect(validate(asset).issues.some((i) => i.location === `accessors[1].${key}` && message.test(i.message))).toBe(true);
  });

  it('rejects normalized floats', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.accessors?.[1]) json.accessors[1].normalized = true;
    });
    expect(only(asset, 'ACCESSOR_ENUM').message).toBe('normalized cannot be used with FLOAT data.');
  });

  it('rejects min or max of the wrong length and min above max', () => {
    const wrongLength = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.accessors?.[0]) json.accessors[0].min = [0, 0];
    });
    expect(only(wrongLength, 'ACCESSOR_MINMAX').message).toContain('array of 3 numbers to match type VEC3');
    const inverted = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.accessors?.[0]) json.accessors[0].min = [9, 9, 9];
    });
    expect(only(inverted, 'ACCESSOR_MINMAX').message).toContain('min has a component larger');
  });

  it('warns that sparse accessors were not checked', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      const accessor = json.accessors?.[2];
      if (accessor) accessor.sparse = { count: 1, indices: { bufferView: 0, componentType: 5123 }, values: { bufferView: 1 } };
    });
    expect(only(asset, 'ACCESSOR_SPARSE_SKIPPED')).toMatchObject({ severity: 'warning', message: 'accessors[2] is sparse. gltf-forge does not read sparse accessors yet, so its data was not checked.' });
  });
});

describe('primitives', () => {
  it('requires min and max on POSITION', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      delete json.accessors?.[0]?.min;
      delete json.accessors?.[0]?.max;
    });
    expect(only(asset, 'ACCESSOR_MINMAX').message).toBe('accessors[0] is used as POSITION, so min and max are required. Viewers use them to compute bounding boxes.');
  });

  it('compares min and max with the data', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.accessors?.[0]) json.accessors[0].max = [0.4, 0.5, 0.5];
    });
    expect(only(asset, 'ACCESSOR_MINMAX').message).toMatch(/accessors\[0\] declares min \[-0\.5,-0\.5,-0\.5\] and max \[0\.4,0\.5,0\.5\], but the data actually spans \[-0\.5,-0\.5,-0\.5\] to \[0\.5,0\.5,0\.5\]/);
  });

  it('rejects attributes with different counts', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.accessors?.[1]) json.accessors[1].count = 560;
    });
    expect(only(asset, 'PRIMITIVE_COUNT').message).toBe('meshes[0].primitives[0] attribute NORMAL has 560 elements but earlier attributes have 561. All attributes of a primitive must have the same count.');
  });

  it('rejects POSITION that is not VEC3 of FLOAT', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.accessors?.[0]) json.accessors[0].type = 'VEC2';
      if (json.accessors?.[0]) json.accessors[0].min = [0, 0];
      if (json.accessors?.[0]) json.accessors[0].max = [1, 1];
    });
    expect(validate(asset).issues.map((i) => i.message)).toContain('meshes[0].primitives[0] POSITION must be VEC3 of FLOAT, but accessors[0] is VEC2 of FLOAT.');
  });

  it('rejects indices that are not unsigned integers', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.accessors?.[3]) json.accessors[3].componentType = 5126;
    });
    expect(only(asset, 'PRIMITIVE_INDICES').message).toBe('meshes[0].primitives[0] indices must be SCALAR of UNSIGNED_BYTE, UNSIGNED_SHORT or UNSIGNED_INT, but accessors[3] is SCALAR of FLOAT.');
  });

  it('rejects a triangle list whose index count is not a multiple of 3', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      if (json.accessors?.[3]) json.accessors[3].count = 2879;
    });
    expect(only(asset, 'PRIMITIVE_COUNT').message).toBe('meshes[0].primitives[0] draws 2879 indices, which is not a multiple of 3, so the last triangle is incomplete.');
  });

  it('rejects a mode that needs more vertices than the primitive draws', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      const primitive = json.meshes?.[0]?.primitives[0];
      if (primitive) {
        delete primitive.indices;
        primitive.mode = 99;
      }
    });
    expect(only(asset, 'PRIMITIVE_MODE').message).toBe('mode must be an integer from 0 to 6, found 99.');
  });

  it('rejects an index that points past the last vertex, using the real data', () => {
    const asset = patchedGlb('sphere.glb', (bin, json) => {
      const view = json.bufferViews?.[3];
      setU16(bin, (view?.byteOffset ?? 0) + 40, 700);
    });
    expect(only(asset, 'PRIMITIVE_INDEX_RANGE').message).toBe('meshes[0].primitives[0] has an index of 700, but the primitive only has 561 vertices (valid indices are 0 to 560).');
  });

  it('treats the last vertex as valid and the vertex count itself as one past the end', () => {
    const last = patchedGlb('sphere.glb', (bin, json) => {
      setU16(bin, (json.bufferViews?.[3]?.byteOffset ?? 0) + 40, 560);
    });
    expect(validate(last).issues).toEqual([]);
    const pastEnd = patchedGlb('sphere.glb', (bin, json) => {
      setU16(bin, (json.bufferViews?.[3]?.byteOffset ?? 0) + 40, 561);
    });
    expect(only(pastEnd, 'PRIMITIVE_INDEX_RANGE').message).toContain('has an index of 561');
  });

  it('draws exactly as many vertices as the mode needs, and rejects one fewer', () => {
    const draw = (mode: number, count: number): Asset => {
      const bin = new Uint8Array(12 * count);
      return parseAsset(
        makeGlb(
          {
            asset: { version: '2.0' },
            buffers: [{ byteLength: bin.byteLength }],
            bufferViews: [{ buffer: 0, byteLength: bin.byteLength }],
            accessors: [{ bufferView: 0, componentType: 5126, count, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0] }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode }] }],
          },
          bin,
        ),
      );
    };
    for (const [mode, need] of [[0, 1], [1, 2], [2, 2], [3, 2], [4, 3], [5, 3], [6, 3]] as const) {
      expect(validate(draw(mode, need)).issues, `mode ${mode} with ${need} vertices`).toEqual([]);
      if (need > 1) {
        expect(only(draw(mode, need - 1), 'PRIMITIVE_COUNT').message, `mode ${mode}`).toContain(`needs at least ${need}`);
      }
    }
  });

  it('rejects the primitive restart value in 32-bit indices', async () => {
    const asset = await loadFixture('torus.gltf');
    const bin = asset.buffers[0];
    const view = asset.json.bufferViews?.[3];
    if (bin === null || bin === undefined) throw new Error('missing buffer');
    setU32(bin, (view?.byteOffset ?? 0) + 8, 0xffffffff);
    expect(only(asset, 'PRIMITIVE_INDEX_RANGE').message).toBe('meshes[0].primitives[0] index 2 holds 4294967295, the primitive restart value, which glTF does not allow.');
  });

  it('warns about a primitive with no POSITION, and rejects one with no attributes', () => {
    const noPosition = mutated(loadGlb('sphere.glb'), (json) => {
      const primitive = json.meshes?.[0]?.primitives[0];
      if (primitive) delete primitive.attributes.POSITION;
    });
    expect(only(noPosition, 'PRIMITIVE_ATTRIBUTES')).toMatchObject({ severity: 'warning' });
    const empty = mutated(loadGlb('sphere.glb'), (json) => {
      const primitive = json.meshes?.[0]?.primitives[0];
      if (primitive) primitive.attributes = {};
    });
    expect(only(empty, 'PRIMITIVE_ATTRIBUTES').message).toBe('meshes[0].primitives[0] needs an "attributes" object with at least one entry.');
  });

  it('rejects a mesh with no primitives', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      const mesh = json.meshes?.[0];
      if (mesh) mesh.primitives = [];
    });
    expect(only(asset, 'PRIMITIVE_ATTRIBUTES').message).toBe('meshes[0] needs a non-empty "primitives" array.');
  });
});

describe('images, samplers and materials', () => {
  it('requires exactly one of uri and bufferView', async () => {
    const both = mutated(await loadFixture('textured-cube.gltf'), (json) => {
      const image = json.images?.[0];
      if (image) image.bufferView = 0;
    });
    expect(only(both, 'IMAGE_SOURCE').message).toBe('images[0] has both a uri and a bufferView. It must have exactly one.');
    const neither = mutated(await loadFixture('textured-cube.gltf'), (json) => {
      const image = json.images?.[0];
      if (image) delete image.uri;
    });
    expect(only(neither, 'IMAGE_SOURCE').message).toBe('images[0] has neither a uri nor a bufferView. It must have exactly one.');
  });

  it('requires mimeType for an image in a bufferView', () => {
    const asset = mutated(loadGlb('textured-cube.glb'), (json) => {
      const image = json.images?.[1];
      if (image) delete image.mimeType;
    });
    expect(only(asset, 'IMAGE_MIME').message).toBe('images[1] is stored in a bufferView, so mimeType is required (for example "image/png").');
  });

  it('warns when the declared mimeType does not match the bytes', () => {
    const asset = mutated(loadGlb('textured-cube.glb'), (json) => {
      const image = json.images?.[1];
      if (image) image.mimeType = 'image/jpeg';
    });
    expect(only(asset, 'IMAGE_MIME')).toMatchObject({ severity: 'warning', message: 'images[1] declares image/jpeg but the bytes are image/png.' });
  });

  it('warns when image bytes are not a readable image', () => {
    const asset = patchedGlb('textured-cube.glb', (bin, json) => {
      const view = json.bufferViews?.[json.images?.[0]?.bufferView ?? 0];
      bin[view?.byteOffset ?? 0] = 0;
    });
    expect(only(asset, 'IMAGE_UNREADABLE')).toMatchObject({ severity: 'warning', location: 'images[0]' });
  });

  it('reports a data URI image that is not valid base64', () => {
    const asset = parseAsset(makeGlb({ asset: { version: '2.0' }, images: [{ uri: 'data:image/png;base64,@@@@' }] }));
    expect(only(asset, 'IMAGE_UNREADABLE').message).toContain('Invalid base64 data');
  });

  it('checks sampler enums, material ranges and alpha mode', async () => {
    const asset = mutated(await loadFixture('textured-cube.gltf'), (json) => {
      const sampler = json.samplers?.[0];
      if (sampler) sampler.minFilter = 1;
      const material = json.materials?.[0];
      if (material?.pbrMetallicRoughness) {
        material.pbrMetallicRoughness.metallicFactor = 2;
        material.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 7];
      }
      if (material) {
        material.alphaMode = 'CLEAR' as 'MASK';
        material.alphaCutoff = -1;
      }
    });
    const messages = validate(asset).issues.map((i) => `${i.location}: ${i.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        'samplers[0].minFilter: minFilter must be one of 9728, 9729, 9984, 9985, 9986, 9987, found 1.',
        'materials[0].pbrMetallicRoughness.metallicFactor: must be a number between 0 and 1, found 2.',
        'materials[0].pbrMetallicRoughness.baseColorFactor: baseColorFactor components must be between 0 and 1.',
        'materials[0].alphaMode: must be "OPAQUE", "MASK" or "BLEND", found "CLEAR".',
        'materials[0].alphaCutoff: must be a number of at least 0, found -1.',
      ]),
    );
  });
});

describe('the node hierarchy', () => {
  it('finds a cycle and names the nodes in it', () => {
    const asset = mutated(loadGlb('scene-50-nodes.glb'), (json) => {
      json.nodes?.[1]?.children?.push(0);
    });
    const issue = validate(asset).issues.find((i) => i.code === 'NODE_CYCLE');
    expect(issue?.message).toBe('nodes[1] has nodes[0] as a child, but nodes[0] is already one of its ancestors. The node hierarchy must not contain cycles.');
  });

  it('finds a node with two parents', () => {
    const asset = mutated(loadGlb('scene-50-nodes.glb'), (json) => {
      json.nodes?.[1]?.children?.push(9);
    });
    expect(only(asset, 'NODE_PARENT').message).toMatch(/^nodes\[9\] is a child of both nodes\[\d+\] and nodes\[\d+\]\. A node can have only one parent\.$/);
  });

  it('finds a scene root that has a parent', () => {
    const asset = mutated(loadGlb('scene-50-nodes.glb'), (json) => {
      json.scenes = [{ nodes: [0, 1] }];
    });
    expect(only(asset, 'NODE_PARENT').message).toBe('scenes[0] lists nodes[1] as a root, but it is a child of nodes[0]. Scene roots must not have parents.');
  });

  it('does not overflow the stack on a chain of 20000 nodes', () => {
    const nodes = Array.from({ length: 20000 }, (_, i) => (i < 19999 ? { children: [i + 1] } : {}));
    const asset = parseAsset(makeGlb({ asset: { version: '2.0' }, nodes, scenes: [{ nodes: [0] }] }));
    expect(validate(asset).ok).toBe(true);
  });

  it('rejects a matrix combined with TRS, and warns about a rotation that is not normalized', () => {
    const asset = mutated(loadGlb('scene-50-nodes.glb'), (json) => {
      const node = json.nodes?.[2];
      if (node) node.matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const other = json.nodes?.[3];
      if (other) other.rotation = [0, 0, 0, 2];
    });
    const issues = validate(asset).issues;
    expect(issues.find((i) => i.severity === 'error')?.message).toBe('nodes[2] has both a matrix and translation, rotation or scale. A node may use one or the other.');
    expect(issues.find((i) => i.severity === 'warning')?.message).toBe('nodes[3] rotation is a quaternion of length 2.0000. It should be normalized to length 1.');
  });

  it('rejects a transform array of the wrong length', () => {
    const asset = mutated(loadGlb('scene-50-nodes.glb'), (json) => {
      const node = json.nodes?.[2];
      if (node) node.translation = [1, 2];
    });
    expect(only(asset, 'TYPE_MISMATCH').message).toBe('must be an array of 3 numbers, found [1,2].');
  });
});

describe('animations and cameras', () => {
  const triangleAnimation = {
    asset: { version: '2.0' },
    nodes: [{}],
    buffers: [{ byteLength: 32 }],
    bufferViews: [{ buffer: 0, byteLength: 32 }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 0, byteOffset: 8, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    animations: [{ samplers: [{ input: 0, output: 1 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }],
  };

  it('accepts a well-formed animation', () => {
    expect(validate(parseAsset(makeGlb(triangleAnimation, new Uint8Array(32)))).issues).toEqual([]);
  });

  it('checks samplers, channels and target paths', () => {
    const broken = structuredClone(triangleAnimation);
    broken.animations = [{ samplers: [{ input: 5, output: 1, interpolation: 'SMOOTH' } as never], channels: [{ sampler: 3, target: { node: 4, path: 'color' } }] }];
    const messages = validate(parseAsset(makeGlb(broken, new Uint8Array(32)))).issues.map((i) => `${i.location}: ${i.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        'animations[0].samplers[0].input: accessors[5] does not exist; the asset has 2 accessors.',
        'animations[0].samplers[0].interpolation: must be LINEAR, STEP or CUBICSPLINE, found "SMOOTH".',
        'animations[0].channels[0].sampler: samplers[3] does not exist; animations[0] has 1 samplers.',
        'animations[0].channels[0].target.node: nodes[4] does not exist; the asset has 1 nodes.',
        'animations[0].channels[0].target.path: must be translation, rotation, scale or weights, found "color".',
      ]),
    );
  });

  it('needs both a camera type and its matching object', () => {
    const asset = parseAsset(makeGlb({ asset: { version: '2.0' }, cameras: [{ type: 'perspective' }, { type: 'fisheye' }] }));
    expect(validate(asset).issues.map((i) => i.message)).toEqual(['cameras[0] has type "perspective" so it needs a "perspective" object.', 'must be "perspective" or "orthographic", found "fisheye".']);
  });
});

describe('malformed JSON that parses', () => {
  it('reports wrong types and does not throw', () => {
    const asset = parseAsset(
      makeGlb({
        asset: { version: '2.0' },
        accessors: [null, 5, 'x', { count: 'many' }],
        meshes: [{ primitives: [null, { attributes: [] }] }],
        nodes: [{ children: 'x', mesh: {} }],
        materials: 'none',
        buffers: [{}, { byteLength: 4, uri: 7 }],
        bufferViews: [{ buffer: 'a' }],
        extensionsUsed: 'KHR',
      }),
    );
    const result = validate(asset);
    expect(result.ok).toBe(false);
    expect(result.errors).toBeGreaterThan(8);
    expect(result.issues.map((i) => i.message)).toEqual(expect.arrayContaining(['"materials" must be an array but is a string.', '"extensionsUsed" must be an array of extension names.']));
  });

  it('reports a missing asset object', () => {
    const asset = parseAsset(new TextEncoder().encode('{}'));
    expect(validate(asset).issues[0]).toMatchObject({ code: 'ASSET_VERSION', location: 'asset', message: 'The required "asset" object is missing. Every glTF file needs asset.version.' });
  });

  it('reports a wrong type only once per collection', () => {
    const asset = parseAsset(new TextEncoder().encode('{"asset":{"version":"2.0"},"accessors":4,"meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}]}'));
    const typeIssues = validate(asset).issues.filter((i) => i.code === 'TYPE_MISMATCH' && i.location === 'accessors');
    expect(typeIssues).toHaveLength(1);
  });
});

describe('result shape', () => {
  it('counts errors and warnings separately, and only errors fail the file', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      json.extensionsUsed = ['EXT_meshopt_compression'];
    });
    expect(validate(asset)).toMatchObject({ errors: 0, warnings: 1, ok: true });
    const broken = mutated(asset, (json) => void (json.asset.version = '1.0'));
    expect(validate(broken)).toMatchObject({ errors: 1, warnings: 1, ok: false });
  });

  it('escapes "/" and "~" in JSON pointers', () => {
    const asset = mutated(loadGlb('sphere.glb'), (json) => {
      const primitive = json.meshes?.[0]?.primitives[0];
      if (primitive) primitive.attributes['A/B~C'] = 77;
    });
    expect(only(asset, 'INDEX_OUT_OF_RANGE').path).toBe('/meshes/0/primitives/0/attributes/A~1B~0C');
  });
});
