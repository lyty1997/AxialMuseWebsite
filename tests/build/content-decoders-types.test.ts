import assert from "node:assert/strict";
import test from "node:test";
import type {
  DecodeFrontMatterOptions,
  DecodedFrontMatter,
  decodeFrontMatter,
  FrontMatterParser,
} from "../../scripts/content/frontmatter.mjs";
import type {
  DecodeJsonDocumentOptions,
  decodeJsonDocument,
} from "../../scripts/content/json.mjs";

type FrontMatterDecoder = typeof decodeFrontMatter;
type JsonDecoder = typeof decodeJsonDocument;

const parser: FrontMatterParser = ({fileContent}) => ({
  content: fileContent,
  frontMatter: {title: "类型契约"},
});

const frontMatterDecoder: FrontMatterDecoder = async (
  options: DecodeFrontMatterOptions,
): Promise<Readonly<DecodedFrontMatter>> => parser(options);

const jsonDecoder: JsonDecoder = (
  _options: DecodeJsonDocumentOptions,
): Record<string, unknown> => ({version: 1});

test("I-06 解码器 .d.mts 公共声明由 E-012 编译并消费", async () => {
  const decodedFrontMatter = await frontMatterDecoder({
    fileContent: "正文",
    filePath: "/private/work/article.mdx",
    sourcePath: "site-content/writing/example/index.mdx",
  });
  const decodedJson = jsonDecoder({
    bytes: new TextEncoder().encode("{\"version\":1}"),
    sourcePath: "docs/contracts/projects.json",
  });

  assert.deepEqual(decodedFrontMatter, {
    content: "正文",
    frontMatter: {title: "类型契约"},
  });
  assert.deepEqual(decodedJson, {version: 1});
});
