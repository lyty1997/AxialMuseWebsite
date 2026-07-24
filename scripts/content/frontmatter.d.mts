export type ContentDecodeErrorCode =
  | "CONTENT_FRONTMATTER_INPUT"
  | "CONTENT_FRONTMATTER_DEPENDENCY"
  | "CONTENT_FRONTMATTER_PARSER"
  | "CONTENT_FRONTMATTER_PARSE"
  | "CONTENT_FRONTMATTER_SHAPE"
  | "CONTENT_JSON_INPUT"
  | "CONTENT_JSON_SIZE"
  | "CONTENT_JSON_UTF8"
  | "CONTENT_JSON_INVALID"
  | "CONTENT_JSON_DEPTH"
  | "CONTENT_JSON_DUPLICATE_KEY"
  | "CONTENT_JSON_ROOT";

export interface FrontMatterParserInput {
  readonly fileContent: string;
  readonly filePath: string;
}

export interface DecodedFrontMatter {
  readonly frontMatter: Readonly<Record<string, unknown>>;
  readonly content: string;
}

export type FrontMatterParser = (
  input: FrontMatterParserInput,
) => DecodedFrontMatter | Promise<DecodedFrontMatter>;

export interface DecodeFrontMatterOptions extends FrontMatterParserInput {
  readonly sourcePath: string;
  readonly parser?: FrontMatterParser;
}

export class ContentDecodeError extends Error {
  readonly code: ContentDecodeErrorCode;
  readonly sourcePath: string;

  constructor(
    code: ContentDecodeErrorCode,
    sourcePath: string,
    options?: ErrorOptions,
  );
}

export function decodeFrontMatter(
  options: DecodeFrontMatterOptions,
): Promise<Readonly<DecodedFrontMatter>>;
