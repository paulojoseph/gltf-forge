export type GltfErrorCode =
  | 'GLB_HEADER'
  | 'GLB_VERSION'
  | 'GLB_LENGTH'
  | 'GLB_CHUNK'
  | 'JSON_PARSE'
  | 'JSON_ROOT'
  | 'URI_DATA'
  | 'URI_UNSAFE'
  | 'URI_UNSUPPORTED'
  | 'FILE_READ'
  | 'FILE_WRITE'
  | 'RESOURCE_MISSING'
  | 'ACCESSOR_READ'
  | 'ASSET_STATE';

/**
 * Thrown when a file cannot be parsed, read or written at all. Problems inside a
 * file that parsed fine are not thrown; they come back from `validate()` as issues.
 */
export class GltfError extends Error {
  readonly code: GltfErrorCode;

  constructor(code: GltfErrorCode, message: string) {
    super(message);
    this.name = 'GltfError';
    this.code = code;
  }
}
