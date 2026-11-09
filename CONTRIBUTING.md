# Contributing

## Setup

You need Node 22 or newer.

```bash
npm ci
npm run check
```

`npm run check` runs ESLint, the TypeScript compiler in strict mode and the Vitest suite. It
must pass before a change is merged, and it must not need the network.

## Ground rules

- **No runtime dependencies.** The package ships with none, on purpose. Read
  [ADR 0001](docs/adr/0001-no-runtime-dependencies.md) before proposing one. A new runtime
  dependency needs its own ADR with the size, maintenance and audit cost measured.
- **An untouched file round trips byte for byte.** Anything that changes how a file is read
  or written has to keep `test/roundtrip.test.ts` passing without editing it.
- **Errors say where and what.** A validator message names the location in the file and
  what is wrong, with the numbers in it. Add a test that asserts the exact message.
- **Tests do not use the network.** They run against the committed fixtures and against
  small assets built in memory.

## Fixtures

The files under `fixtures/` are generated, committed and compared with the generator by a
test. To change them, edit `scripts/generate-fixtures.mjs`, run `npm run fixtures`, and commit
the script and the regenerated files together. Do not edit a fixture by hand.

The generator does not import the library. Keep it that way, so the tests check the parser
against files it did not produce.

## Documentation

The numbers in the README tables are measured from the fixtures. A test compares the
"on disk" column with the real files. When a fixture changes, rerun
`node dist/bin.js inspect fixtures/<file> --json` and update the table.
