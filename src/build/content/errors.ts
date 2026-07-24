export class ContentBuildError extends Error {
  readonly code: string;
  readonly sourcePath?: string;
  readonly upstreamCode?: string;

  constructor(
    code: string,
    message: string,
    options: Readonly<{
      cause?: unknown;
      sourcePath?: string;
      upstreamCode?: string;
    }> = {},
  ) {
    super(message, {cause: options.cause});
    this.name = "ContentBuildError";
    this.code = code;
    this.sourcePath = options.sourcePath;
    this.upstreamCode = options.upstreamCode;
  }
}

export function failContentBuild(
  code: string,
  message: string,
  options: Readonly<{
    cause?: unknown;
    sourcePath?: string;
    upstreamCode?: string;
  }> = {},
): never {
  throw new ContentBuildError(code, message, options);
}

export function formatContentBuildError(error: unknown): string {
  if (!(error instanceof ContentBuildError)) {
    return "[CONTENT_BUILD_INTERNAL] 内容装配发生未分类错误；底层细节已抑制。";
  }
  const location = error.sourcePath === undefined ? "" : ` (${error.sourcePath})`;
  const upstream = error.upstreamCode === undefined
    ? ""
    : ` [upstream=${error.upstreamCode}]`;
  return `[${error.code}]${location}${upstream} ${error.message}`;
}
