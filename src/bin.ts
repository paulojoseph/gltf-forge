#!/usr/bin/env node
import { run } from './cli.js';

run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr }).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`forge: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 2;
  },
);
