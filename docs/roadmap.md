# Roadmap

gltf-forge grows in five milestones. Each one ships something usable on its own and leaves the
tests green. Only the first is built.

| Milestone | Scope | Status |
| --- | --- | --- |
| M1 | Read, write, validate and inspect | Done |
| M2 | Mesh decimation with a quality metric | Open |
| M3 | Texture atlas and resize | Open |
| M4 | Automatic LOD chain | Open |
| M5 | Size budget that fails CI | Open |

## M1: read, write, validate, inspect (done)

Shipped in 0.1.0.

- [x] Parse and write `.gltf` and `.glb` with a full round trip. Untouched files come back byte for byte, including GLB padding, unknown chunks, external buffers and images, and data URIs.
- [x] A validator that reports every problem with a location, a message with the numbers in it, and a stable code.
- [x] `forge inspect`: triangle counts per mesh, texture sizes, and the byte budget of each buffer.
- [x] `forge validate`, `--json` output, and documented exit codes.
- [x] Procedural fixtures and a test that keeps them in sync with their generator.

### Gaps M1 leaves on purpose

These are the places where the code does the simple thing today. Each is tied to the milestone that has to replace it.

| Gap | Where it shows | Closed by |
| --- | --- | --- |
| `readAccessor` copies a whole accessor into memory. | Large meshes use that much memory; there is no streaming or partial read. | M2 |
| No way to write new accessors or bufferViews. `withJson` re-encodes the JSON but cannot add data to the buffer. | Nothing can yet produce a smaller mesh. | M2 |
| Sparse accessors are skipped, with a warning. | Morph targets stored sparsely are not validated or measured. | M2 |
| Images are measured, not decoded. | No resizing, no atlas, no format change. | M3 |
| A `.gltf` cannot be converted to a `.glb`. | Packing external files into one container. | M3 |
| Compressed geometry (`KHR_draco_mesh_compression`, `EXT_meshopt_compression`) is not decoded. | The validator warns and skips data checks. | M2 or later |
| Only one report format and no configuration file. | Limits cannot be expressed or enforced. | M5 |

## M2: mesh decimation with a quality metric (open)

Reduce the triangle count of a mesh and say how much the shape changed.

- Simplify indexed triangle meshes by collapsing edges in order of geometric error, keeping UV seams, hard edges and material borders intact.
- Report a quality metric for every decimated mesh: the largest and mean distance from the original surface, as a fraction of the bounding-box diagonal.
- `forge decimate <file> --ratio <0..1> --max-error <fraction>` stops at whichever limit is reached first, and exits non-zero if the error limit cannot be met.
- Needs a way to add accessors and bufferViews to an asset and write the new buffer, and an accessor reader that does not copy the whole accessor.

Done when: decimating the sphere and torus fixtures to 50% produces a valid file, `forge inspect` shows the new triangle counts, and a test asserts the reported error against an independently computed distance.

## M3: texture atlas and resize (open)

Make textures smaller, and fewer.

- Resize textures to a maximum dimension, optionally to a power of two, and re-encode them.
- Pack textures that share a material into an atlas and rewrite UV coordinates to match.
- Convert a `.gltf` with external files into a single `.glb`.
- This is the first milestone that needs an image codec. [ADR 0001](adr/0001-no-runtime-dependencies.md) says what a dependency has to justify before it is added.

Done when: `forge inspect` on the textured-cube fixture shows smaller `encoded` and `gpu (est.)` values after a resize, and a test decodes the output and compares it with the source.

## M4: automatic LOD chain (open)

Generate several levels of detail for each mesh.

- Build a chain of decimated meshes from M2 with a target ratio per level.
- Write the chain as a standard LOD structure, and report the triangle count of each level in `forge inspect`.
- Choose screen-coverage thresholds from the mesh's bounding sphere, and let the user override them.

Done when: a scene with a LOD chain validates, and `inspect` lists every level.

## M5: size budget that fails CI (open)

Turn the numbers `forge inspect` prints into limits a build can enforce.

- A budget file that sets limits on total bytes, bytes per category, triangles drawn, and estimated GPU texture memory.
- `forge budget <file>` prints each limit, the measured value and the margin, and exits non-zero when a limit is exceeded.
- A documented GitHub Actions workflow that runs it on every pull request and posts the table.

Done when: a fixture that exceeds a limit fails the command with exit code 1 and names the limit, and the same fixture under the limit passes.
