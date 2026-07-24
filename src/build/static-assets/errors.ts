export class StaticAssetError extends Error {
  readonly code: string;
  readonly sourcePath?: string;
  readonly upstreamCode?: string;

  constructor(
    code: string,
    message: string,
    options: ErrorOptions & Readonly<{
      sourcePath?: string;
      upstreamCode?: string;
    }> = {},
  ) {
    super(message, options);
    this.name = "StaticAssetError";
    this.code = code;
    this.sourcePath = options.sourcePath;
    this.upstreamCode = options.upstreamCode;
  }
}

export function failStaticAsset(
  code: string,
  message: string,
  options: ErrorOptions & Readonly<{
    sourcePath?: string;
    upstreamCode?: string;
  }> = {},
): never {
  throw new StaticAssetError(code, message, options);
}

export function formatStaticAssetError(error: unknown): string {
  if (!(error instanceof StaticAssetError)) {
    return "[STATIC_ASSET_INTERNAL] 静态素材处理发生未分类错误；详细堆栈已抑制。";
  }
  const location = error.sourcePath === undefined ? "" : ` (${error.sourcePath})`;
  const upstream = error.upstreamCode === undefined ? "" : ` [${error.upstreamCode}]`;
  return `[${error.code}]${upstream}${location} ${error.message}`;
}
