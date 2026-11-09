import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { GltfError } from './gltf/errors.js';
import { readAsset } from './gltf/io.js';
import { validate, type Issue, type ValidationResult } from './gltf/validate.js';
import { formatReport, inspectAsset, type InspectReport } from './inspect.js';

export interface Output {
  write(text: string): unknown;
}

export interface CliIo {
  stdout: Output;
  stderr: Output;
}

const USAGE = `forge - inspect and validate glTF 2.0 and GLB files

Usage
  forge inspect <file> [--json] [--allow-parent-paths]
  forge validate <file> [--json] [--allow-parent-paths]
  forge --help
  forge --version

Commands
  inspect    Triangle counts per mesh, texture sizes, and where the bytes of each
             buffer go. Validation problems are listed after the report.
  validate   Check the file against the glTF 2.0 rules and list every problem.

Options
  --json                 Print machine-readable JSON instead of text.
  --allow-parent-paths   Let external URIs use ".." to reach files outside the
                         folder of the glTF. Off by default.

Exit codes
  0  The file was read and has no validation errors (warnings are allowed).
  1  The file was read but has validation errors.
  2  Bad usage, or the file could not be read or parsed.
`;

function version(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

function formatIssues(issues: Issue[]): string[] {
  return issues.map((issue) => `  ${issue.severity.padEnd(7)} ${issue.location === '' ? '(root)' : issue.location}\n          ${issue.message} [${issue.code}]`);
}

function summary(result: ValidationResult): string {
  if (result.issues.length === 0) return 'Validation: no problems found.';
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `Validation: ${plural(result.errors, 'error')}, ${plural(result.warnings, 'warning')}.`;
}

interface Parsed {
  command: string;
  file: string;
  json: boolean;
  allowParentPaths: boolean;
}

function parseArgs(args: string[]): Parsed | string {
  const [command, ...rest] = args;
  if (command === undefined) return 'Missing command.';
  if (command !== 'inspect' && command !== 'validate') return `Unknown command "${command}".`;
  let file: string | undefined;
  let json = false;
  let allowParentPaths = false;
  for (const arg of rest) {
    if (arg === '--json') json = true;
    else if (arg === '--allow-parent-paths') allowParentPaths = true;
    else if (arg.startsWith('-')) return `Unknown option "${arg}".`;
    else if (file === undefined) file = arg;
    else return `Unexpected extra argument "${arg}". ${command} takes one file.`;
  }
  if (file === undefined) return `"${command}" needs a file to read.`;
  return { command, file, json, allowParentPaths };
}

/**
 * Runs the CLI. Takes the arguments after `node forge` and returns the exit code,
 * so tests can drive it without spawning a process.
 */
export async function run(args: string[], io: CliIo): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    io.stdout.write(`${version()}\n`);
    return 0;
  }

  const parsed = parseArgs(args);
  if (typeof parsed === 'string') {
    io.stderr.write(`forge: ${parsed}\nRun "forge --help" for usage.\n`);
    return 2;
  }

  let result: ValidationResult;
  let report: InspectReport | undefined;
  let reportFailure: string | undefined;
  try {
    const asset = await readAsset(parsed.file, { allowParentPaths: parsed.allowParentPaths });
    result = validate(asset);
    if (parsed.command === 'inspect') {
      try {
        report = inspectAsset(asset, { name: basename(parsed.file) });
      } catch (error) {
        reportFailure = error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    if (error instanceof GltfError) {
      io.stderr.write(`forge: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  if (parsed.json) {
    io.stdout.write(`${JSON.stringify({ file: parsed.file, validation: result, ...(report === undefined ? {} : { report }) }, null, 2)}\n`);
  } else {
    const lines: string[] = [];
    if (report !== undefined) lines.push(formatReport(report), '');
    if (reportFailure !== undefined) lines.push(`The report could not be built because the file is malformed (${reportFailure}).`, '');
    if (result.issues.length > 0) lines.push(...formatIssues(result.issues), '');
    lines.push(summary(result));
    io.stdout.write(`${lines.join('\n')}\n`);
  }
  return result.ok ? 0 : 1;
}
