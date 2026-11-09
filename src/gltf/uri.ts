import { GltfError } from './errors.js';

export type UriKind = 'data' | 'remote' | 'relative';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64_ALPHABET.length; i++) {
  BASE64_LOOKUP[BASE64_ALPHABET.charCodeAt(i)] = i;
}

/** Decodes standard (RFC 4648) base64 with padding. Whitespace is ignored. */
export function decodeBase64(input: string): Uint8Array {
  const text = input.replace(/\s+/g, '');
  if (text.length % 4 !== 0) {
    throw new GltfError('URI_DATA', `Invalid base64 data: length ${text.length} is not a multiple of 4.`);
  }
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x3d) end--;
  if (text.length - end > 2) {
    throw new GltfError('URI_DATA', 'Invalid base64 data: more than two "=" padding characters.');
  }
  const out = new Uint8Array(Math.floor((end * 6) / 8));
  let acc = 0;
  let bits = 0;
  let written = 0;
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? BASE64_LOOKUP[code] : -1;
    if (value === undefined || value < 0) {
      throw new GltfError('URI_DATA', `Invalid base64 data: unexpected character ${JSON.stringify(text[i])} at position ${i}.`);
    }
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

export function classifyUri(uri: string): UriKind {
  if (/^data:/i.test(uri)) return 'data';
  if (/^https?:\/\//i.test(uri)) return 'remote';
  // Two or more letters before the colon is a URI scheme. A single letter is a Windows
  // drive, which relativeUriToSegments rejects as unsafe.
  const scheme = /^([a-z][a-z0-9+.-]+):/i.exec(uri);
  if (scheme !== null) {
    throw new GltfError(
      'URI_UNSUPPORTED',
      `The URI scheme "${scheme[1] ?? ''}:" is not supported. Use a relative path, a data: URI, or an http(s) URL.`,
    );
  }
  return 'relative';
}

export interface DataUri {
  mimeType: string;
  bytes: Uint8Array;
}

export function decodeDataUri(uri: string): DataUri {
  const comma = uri.indexOf(',');
  if (!/^data:/i.test(uri) || comma < 0) {
    throw new GltfError('URI_DATA', 'Malformed data URI: expected "data:<mime>;base64,<payload>".');
  }
  const header = uri.slice(5, comma);
  const parts = header.split(';');
  const last = parts[parts.length - 1]?.toLowerCase();
  if (last !== 'base64') {
    throw new GltfError('URI_DATA', 'Unsupported data URI: only base64-encoded payloads are supported.');
  }
  return { mimeType: parts[0] ?? '', bytes: decodeBase64(uri.slice(comma + 1)) };
}

export interface SegmentOptions {
  /** Accept ".." segments. Off by default so an asset cannot point outside its own folder. */
  allowParentPaths?: boolean;
}

/**
 * Turns a relative glTF URI into decoded path segments, rejecting anything that
 * could escape the asset's folder (absolute paths, drive letters, backslashes,
 * encoded separators and, unless allowed, ".." segments).
 */
export function relativeUriToSegments(uri: string, options: SegmentOptions = {}): string[] {
  const unsafe = (why: string): GltfError => new GltfError('URI_UNSAFE', `Refusing to use the URI "${uri}": ${why}.`);
  if (uri.length === 0) throw unsafe('it is empty');
  if (uri.includes('\\')) throw unsafe('it contains a backslash, and glTF URIs use "/"');
  if (uri.startsWith('/')) throw unsafe('it is an absolute path');
  if (/^[a-z]:/i.test(uri)) throw unsafe('it starts with a drive letter');
  const segments: string[] = [];
  for (const raw of uri.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      throw unsafe('it contains an invalid percent escape');
    }
    if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
      throw unsafe('a path segment decodes to a separator or a NUL character');
    }
    if (segment === '' || segment === '.') continue;
    if (segment === '..' && options.allowParentPaths !== true) {
      throw unsafe('it climbs out of the asset folder with ".." (pass allowParentPaths to permit this)');
    }
    segments.push(segment);
  }
  if (segments.length === 0) throw unsafe('it does not name a file');
  return segments;
}
