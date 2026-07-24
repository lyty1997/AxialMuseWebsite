import type {ContentDecodeError} from "./frontmatter.mjs";

export {ContentDecodeError} from "./frontmatter.mjs";

export const CONTENT_JSON_MAX_BYTES: number;
export const CONTENT_JSON_MAX_DEPTH: number;

export interface DecodeJsonDocumentOptions {
  readonly bytes: Uint8Array;
  readonly sourcePath: string;
}

export function decodeJsonDocument(
  options: DecodeJsonDocumentOptions,
): Record<string, unknown>;

export type JsonContentDecodeError = ContentDecodeError;
