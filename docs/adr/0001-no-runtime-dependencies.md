# ADR 0001: No runtime dependencies beyond the glTF spec types

- Status: Accepted
- Date: 2026-11-09

## Context

gltf-forge reads and rewrites files that other people's pipelines produce and other people's
viewers consume. Three properties matter more than convenience.

1. **An untouched file must come back byte for byte.** That includes GLB padding, chunks the
   spec does not define, and the exact JSON text. A library that builds its own document
   model and serializes it again will normalize the file, and then the tool cannot say "I did
   not change this".
2. **It runs in CI and on build machines.** Every dependency is install time, audit surface
   and a supply chain risk for everyone who adds this package to a build.
3. **The format is small and stable.** The glTF 2.0 container is a 12-byte header and a list
   of length-prefixed chunks. The core JSON schema has been stable since glTF 2.0 was
   published in 2017. The hard parts of the roadmap (decimation, resizing, atlas packing) are
   not things a general glTF library would have done for us.

## Decision

The published package has no entries in `dependencies`. The glTF 2.0 schema is written by
hand as TypeScript types in `src/gltf/types.ts`. Types are declarations only, so they add no
runtime code and no install-time cost.

Everything else the package needs is written in the repository: the GLB container, base64
and data URIs, accessor reading, image header parsing, the validator and the report.
`devDependencies` (TypeScript, ESLint, Vitest and their plugins) are build and test tools
and are not installed by users of the package.

## Consequences

Good:

- `npm install gltf-forge` installs one package. There is nothing to audit but this code.
- The parser owns the bytes. The round trip guarantee comes from a small part of
  `src/gltf/glb.ts` and `src/gltf/asset.ts`, and `test/roundtrip.test.ts` pins it.
- The tests need no network and no native modules.

Costs we accept:

- We maintain the schema types. A change to the glTF spec means a change here. The spec is
  stable, and the types are checked by the fixtures and the validator tests.
- We maintain a validator that is narrower than the Khronos glTF Validator. The README says
  so, and recommends running that validator in CI for full conformance.
- Code that a library would give for free (base64 decoding, image header parsing) is ours to
  test. It is small, and it is covered by tests that compare against Node's own results.

## Alternatives considered

- **Build on glTF Transform.** It is the closest existing tool and a good one for
  read-modify-write. Its model is the document, and a file is written from the model, so
  reading and writing an unchanged file is not guaranteed to reproduce it. It would also make
  the roadmap depend on someone else's design for buffers and accessors.
- **Generate the types from the Khronos JSON schemas.** That adds a build step and a
  dependency on the schema repository, to produce types that are less readable than the ones
  written by hand.
- **Depend on the Khronos validator.** It checks more than this package does, and it is
  complementary. Making it a runtime dependency would make every user pay for it, so we
  recommend it as a separate CI step instead.

## Revisiting this decision

Milestone 3 needs to decode and encode images. That is the first place where writing the
code ourselves may cost more than a dependency. Before a runtime dependency is added, a new
ADR must give: what it does that is not reasonable to write here, its install size and the
number of packages it pulls in, how actively it is maintained, and whether it can be an
optional peer dependency used only by the commands that need it, so that `inspect`,
`validate` and the library core stay dependency-free.
