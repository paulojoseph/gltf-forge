import { describe, expect, it } from 'vitest';
import { GltfError, classifyUri, decodeBase64, decodeDataUri, relativeUriToSegments } from '../src/index.js';

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof GltfError) return error.message;
    throw error;
  }
  throw new Error('expected a GltfError');
}

describe('decodeBase64', () => {
  it('matches Node for every payload length, so padding cases are covered', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length * 11) & 0xff);
      const text = Buffer.from(bytes).toString('base64');
      expect(decodeBase64(text)).toEqual(bytes);
    }
  });

  it('ignores whitespace and rejects anything else that is not base64', () => {
    expect(decodeBase64('AAEC\nAw==')).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(message(() => decodeBase64('AAE'))).toContain('not a multiple of 4');
    expect(message(() => decodeBase64('AA=A'))).toContain('unexpected character');
    expect(message(() => decodeBase64('A==='))).toContain('padding');
    expect(message(() => decodeBase64('AAE*'))).toContain('unexpected character "*"');
  });
});

describe('decodeDataUri', () => {
  it('returns the media type and the decoded bytes', () => {
    const decoded = decodeDataUri('data:application/octet-stream;base64,AQID');
    expect(decoded.mimeType).toBe('application/octet-stream');
    expect(decoded.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects payloads that are not base64', () => {
    expect(message(() => decodeDataUri('data:text/plain,hello'))).toContain('only base64');
    expect(message(() => decodeDataUri('data:nothing'))).toContain('Malformed data URI');
  });
});

describe('classifyUri', () => {
  it('sorts URIs into data, remote and relative', () => {
    expect(classifyUri('data:image/png;base64,AAAA')).toBe('data');
    expect(classifyUri('DATA:image/png;base64,AAAA')).toBe('data');
    expect(classifyUri('https://example.com/a.bin')).toBe('remote');
    expect(classifyUri('HTTP://example.com/a.bin')).toBe('remote');
    expect(classifyUri('textures/a%20b.png')).toBe('relative');
  });

  it('rejects schemes it will not follow', () => {
    expect(message(() => classifyUri('file:///etc/passwd'))).toContain('"file:" is not supported');
    expect(message(() => classifyUri('ftp://host/a.bin'))).toContain('"ftp:" is not supported');
  });
});

describe('relativeUriToSegments', () => {
  it('decodes percent escapes and drops empty and "." segments', () => {
    expect(relativeUriToSegments('textures/./my%20image.png')).toEqual(['textures', 'my image.png']);
    expect(relativeUriToSegments('a//b.bin')).toEqual(['a', 'b.bin']);
  });

  it.each([
    ['/etc/passwd', 'absolute path'],
    ['C:/temp/a.bin', 'drive letter'],
    ['..\\a.bin', 'backslash'],
    ['../a.bin', 'climbs out of the asset folder'],
    ['a/../../b.bin', 'climbs out of the asset folder'],
    ['a%2Fb.bin', 'decodes to a separator'],
    ['a%5Cb.bin', 'decodes to a separator'],
    ['a%00.bin', 'NUL'],
    ['a%E0%A4%A.bin', 'invalid percent escape'],
    ['', 'empty'],
    ['./', 'does not name a file'],
  ])('refuses %j (%s)', (uri, reason) => {
    expect(message(() => relativeUriToSegments(uri))).toContain(reason);
  });

  it('accepts ".." only when asked to', () => {
    expect(relativeUriToSegments('../shared/a.bin', { allowParentPaths: true })).toEqual(['..', 'shared', 'a.bin']);
  });
});
