export type * from './gltf/types.js';
export { ComponentType, PrimitiveMode } from './gltf/types.js';
export { GltfError, type GltfErrorCode } from './gltf/errors.js';
export {
  CHUNK_BIN,
  CHUNK_JSON,
  GLB_MAGIC,
  chunkTypeName,
  isGlb,
  parseGlbChunks,
  serializeGlbChunks,
  type GlbChunk,
} from './gltf/glb.js';
export {
  assetByteLength,
  buildAsset,
  listExternalUris,
  parseAsset,
  parseContainer,
  serializeGlb,
  withJson,
  type Asset,
  type Container,
  type ExternalRef,
} from './gltf/asset.js';
export { readAsset, writeAsset, type IoOptions } from './gltf/io.js';
export { elementByteSize, readAccessor, type AccessorData, type AccessorValues } from './gltf/accessors.js';
export { getImageBytes, readImageInfo, type ImageInfo } from './gltf/image-info.js';
export { classifyUri, decodeBase64, decodeDataUri, relativeUriToSegments, type UriKind } from './gltf/uri.js';
export { validate, type Issue, type IssueCode, type Severity, type ValidationResult } from './gltf/validate.js';
export {
  formatBytes,
  formatReport,
  inspectAsset,
  type BufferReport,
  type ByteCategory,
  type ImageReport,
  type InspectOptions,
  type InspectReport,
  type MeshReport,
  type PrimitiveReport,
} from './inspect.js';
