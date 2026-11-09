# gltf-forge

Parse, validate and inspect glTF 2.0 and GLB files, in TypeScript, with no runtime dependencies. It is the base layer for an optimizer that shrinks scenes for the web.

**Status: milestone 1 of 5.** Reading, writing, validation and `forge inspect` work today. Decimation, texture processing, LODs and size budgets do not exist yet. See [docs/roadmap.md](docs/roadmap.md).

## The problem

A glTF that looks fine in a viewer can be expensive to ship, and the cost is hard to see. Three common surprises:

- A 2048x2048 base color texture can be a few megabytes as a PNG, but it costs about 22 MB of video memory once the browser decodes it and builds mipmaps (2048 x 2048 x 4 bytes, plus a third more for the mip chain).
- A mesh instanced 200 times is stored once, but the GPU draws it 200 times. The file's triangle count and the frame's triangle count are different numbers.
- A `.gltf` that embeds its buffer as a base64 data URI is a third bigger than the same data in a `.glb`.

Before you can optimize anything you need to see where the bytes and the triangles are. `forge inspect` prints that. The later milestones act on it.

## Two minutes

You need Node 22 or newer. The package is not on npm yet, so build it from the repository:

```bash
git clone https://github.com/paulojoseph/gltf-forge.git && cd gltf-forge
npm ci
npm run build
node dist/bin.js inspect fixtures/textured-cube.glb
```

That prints:

```text
textured-cube.glb  (GLB 2.0, 24.7 KiB on disk)
generator: gltf-forge fixture generator
scenes 1, nodes 1, meshes 1, materials 1, textures 3, images 3, animations 0, skins 0

Meshes
  #  name   prims  vertices  triangles  instances  drawn
  -  -----  -----  --------  ---------  ---------  -----
  0  Crate      1        24         12          1     12
  total: 12 triangles stored, 12 drawn from the default scene

Textures
  #  name              size  format  stored      encoded  gpu (est.)  used by
  -  ---------------  -----  ------  ---------  --------  ----------  ------------------------------------------------------
  0  crate_basecolor  64x64  png     in buffer  16.1 KiB    21.3 KiB  materials[0].baseColor
  1  crate_orm        32x32  png     in buffer   3.1 KiB     5.3 KiB  materials[0].metallicRoughness, materials[0].occlusion
  2  crate_normal     32x32  png     in buffer   3.1 KiB     5.3 KiB  materials[0].normal
  gpu (est.) assumes RGBA8 with a full mip chain, the usual cost once a browser has decoded the image.

Buffers
  [0] GLB BIN chunk, 23,700 B declared in 5 bufferViews
      vertex attributes         768 B    3.2%
      indices                    72 B    0.3%
      embedded images        22,860 B   96.5%

Validation: no problems found.
```

Read it from the bottom: 96.5% of this file's bytes are texture data, and the mesh is 840 bytes. Decimating this mesh would save almost nothing. Resizing the textures would save almost everything.

The same thing from code:

```ts
import { readAsset, writeAsset, validate, inspectAsset, formatReport } from 'gltf-forge';

const asset = await readAsset('fixtures/textured-cube.gltf'); // pulls in the .bin and the PNGs too

const { ok, issues } = validate(asset);
for (const issue of issues) console.log(issue.severity, issue.location, issue.message);

console.log(formatReport(inspectAsset(asset, { name: 'textured-cube.gltf' })));

// An untouched asset is written back byte for byte, external files included.
await writeAsset(asset, 'out/textured-cube.gltf');
```

## Before and after

Everything gltf-forge can measure today is a "before". These are the committed fixtures, measured by `forge inspect` and checked against the files by the test suite. They are procedural meshes and textures made by [scripts/generate-fixtures.mjs](scripts/generate-fixtures.mjs), so they are small. Real scenes are larger, and the shape of the table is what carries over.

| Asset | On disk (bytes) | Triangles stored | Triangles drawn | Encoded textures (bytes) | Estimated GPU textures (bytes) |
| --- | ---: | ---: | ---: | ---: | ---: |
| sphere.gltf | 25,629 | 960 | 960 | 0 | 0 |
| sphere.glb | 24,784 | 960 | 960 | 0 | 0 |
| torus.gltf | 91,173 | 2,304 | 2,304 | 0 | 0 |
| torus.glb | 68,016 | 2,304 | 2,304 | 0 | 0 |
| textured-cube.gltf | 26,316 | 12 | 12 | 22,860 | 32,764 |
| textured-cube.glb | 25,308 | 12 | 12 | 22,860 | 32,764 |
| scene-50-nodes.glb | 14,728 | 236 | 4,956 | 0 | 0 |

"On disk" counts a `.gltf` together with its `.bin` and image files. Two things in the table are worth a look. `torus.gltf` embeds its buffer as base64 and is 34% larger than `torus.glb`, which holds the same geometry. And `scene-50-nodes.glb` stores 236 triangles but asks the GPU for 4,956, because two small meshes are instanced 21 times each.

There is no "after" yet, and this README does not invent one. No optimization ships in milestone 1. Each later milestone adds a number that can be compared against the table above, and the last one makes that comparison a CI check:

| Milestone | What changes | Where the "after" number will come from | Status |
| --- | --- | --- | --- |
| M2 mesh decimation | Fewer triangles, with a measured error | `triangles stored`, plus an error metric the command prints | Open |
| M3 texture atlas and resize | Smaller textures, fewer of them | `encoded` and `gpu (est.)` columns | Open |
| M4 LOD chain | Several detail levels per mesh | `triangles drawn` per level | Open |
| M5 size budget | A build that fails when a limit is exceeded | The budget file and its exit code | Open |

## Command line

```text
forge inspect <file> [--json] [--allow-parent-paths]
forge validate <file> [--json] [--allow-parent-paths]
forge --help
forge --version
```

`inspect` prints triangle counts per mesh (stored, instanced and drawn), the size and estimated GPU cost of every image, and where the bytes of each buffer go: vertex attributes, indices, embedded images, animation, skinning, unused bufferViews and padding. Validation problems are listed after the report.

`validate` checks the file and lists every problem with where it is and what is wrong:

```text
error   meshes[0].primitives[0].attributes.NORMAL
          accessors[42] does not exist; the asset has 4 accessors. [INDEX_OUT_OF_RANGE]
```

Exit codes: `0` for a readable file with no errors (warnings are allowed), `1` for validation errors, `2` for bad usage or a file that cannot be read or parsed.

By default a URI such as `../shared.bin` is refused, so a downloaded asset cannot make the tool read files outside its own folder. `--allow-parent-paths` lifts that for files you trust. `--json` prints the report and the validation result as JSON for scripts.

## Library

| Function | What it does |
| --- | --- |
| `readAsset(path)` | Reads a `.gltf` or `.glb` (detected from the content) and loads external buffers and images. |
| `writeAsset(asset, path)` | Writes it back. An untouched asset is byte-identical to what was read. |
| `parseAsset(bytes, files?)` | The same as `readAsset`, from memory. |
| `withJson(asset, json)` | A copy with new JSON. This is the one operation that re-encodes, compactly. |
| `validate(asset)` | Returns `{ ok, errors, warnings, issues }`. Never throws on a malformed asset. |
| `inspectAsset(asset)` | Returns the report as data. `formatReport` turns it into the text above. |
| `readAccessor(asset, index)` | Reads an accessor into a typed array, honouring stride and matrix padding. |
| `readImageInfo(bytes)` | Width and height from a PNG, JPEG or KTX2 header, without decoding pixels. |

The glTF 2.0 schema is exported as TypeScript types (`GltfRoot`, `GltfNode`, and so on).

## What the validator checks

Structure and types of every top-level collection; that every index points at something that exists, with the count in the message; buffer, bufferView and accessor byte ranges, alignment and stride; that `min` and `max` on POSITION match the actual data; that indices stay inside the vertex count and avoid the restart value; that attribute counts agree and index counts fit the draw mode; image sources, MIME types and whether the bytes are readable; sampler and material values; the node hierarchy, including cycles, multiple parents and scene roots with parents; skins, animations and cameras.

It is not the Khronos glTF Validator. It does not check extension payloads or every rule in the spec, and it says so where it skips something (compressed geometry, sparse accessors, remote buffers). For a full conformance check in CI, run the Khronos validator alongside it.

## Known limits

These are real, and some are the starting point for later milestones.

- Accessors are read into memory in one piece. Large assets use that much memory.
- Sparse accessors are not read, and compressed geometry (`KHR_draco_mesh_compression`, `EXT_meshopt_compression`) is not decoded. The validator warns and skips the data checks.
- A `.gltf` cannot be converted to a `.glb` yet.
- Images are measured, not decoded. There is no pixel access.
- Remote URLs are never fetched. Buffers behind an `http(s)` URL are reported, not loaded.

## Development

```bash
npm ci
npm run check      # lint, typecheck and tests
npm run build      # compiles to dist/
npm run fixtures   # regenerates fixtures/ from scripts/generate-fixtures.mjs
```

Nothing in the build or the tests uses the network. The fixtures are generated by code, committed, and compared byte for byte with the generator's output by a test, so they cannot drift. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/adr/0001-no-runtime-dependencies.md](docs/adr/0001-no-runtime-dependencies.md) for why the package has no runtime dependencies.

## License

MIT. See [LICENSE](LICENSE).
