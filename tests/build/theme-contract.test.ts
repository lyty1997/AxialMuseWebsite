import assert from "node:assert/strict";
import {readFileSync, readdirSync, realpathSync} from "node:fs";
import {relative, resolve} from "node:path";
import test from "node:test";

const ROOT = realpathSync(process.cwd());

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function cssSources(directory = resolve(ROOT, "src")): readonly Readonly<{
  path: string;
  value: string;
}>[] {
  const results: Array<{path: string; value: string}> = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      const path = resolve(current, entry.name);
      assert.equal(entry.isSymbolicLink(), false, "src 样式树不得包含符号链接");
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".css")) {
        results.push({
          path: relative(ROOT, path).replaceAll("\\", "/"),
          value: readFileSync(path, "utf8"),
        });
      }
    }
  };
  visit(directory);
  return results;
}

function extractCssBlock(value: string, marker: string): Readonly<{
  block: string;
  end: number;
  start: number;
}> {
  const start = value.indexOf(marker);
  assert.notEqual(start, -1, `缺少 CSS block：${marker}`);
  const openingBrace = value.indexOf("{", start);
  assert.notEqual(openingBrace, -1, `CSS block 缺少起始花括号：${marker}`);
  let depth = 0;
  for (let index = openingBrace; index < value.length; index += 1) {
    if (value[index] === "{") depth += 1;
    if (value[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      return {
        block: value.slice(start, index + 1),
        end: index + 1,
        start,
      };
    }
  }
  assert.fail(`CSS block 缺少结束花括号：${marker}`);
}

test("CODE-008 全局主题只声明已确认令牌、Infima 映射与无动效回退", () => {
  const css = source("src/css/custom.css");
  const expectedTokens = {
    "--am-canvas": "#f4f6f3",
    "--am-surface": "#ffffff",
    "--am-ink": "#171a1c",
    "--am-muted": "#596168",
    "--am-line": "#cfd6d1",
    "--am-accent": "#0b6b5f",
    "--am-signal": "#b94b35",
  };
  for (const [name, value] of Object.entries(expectedTokens)) {
    assert.ok(css.includes(`${name}: ${value};`));
  }
  assert.match(css, /--ifm-line-height-base: 1\.65;/u);
  assert.match(
    css,
    /\.footer__link-item\s*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/su,
  );
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  const reducedMotion = extractCssBlock(
    css,
    "@media (prefers-reduced-motion: reduce)",
  );
  assert.match(reducedMotion.block, /--ifm-transition-fast:\s*0ms;/u);
  assert.match(reducedMotion.block, /--ifm-transition-slow:\s*0ms;/u);
  assert.match(reducedMotion.block, /animation-duration:\s*0ms\s*!important;/u);
  assert.match(reducedMotion.block, /transition-duration:\s*0ms\s*!important;/u);
  assert.equal(
    `${css.slice(0, reducedMotion.start)}${css.slice(reducedMotion.end)}`
      .includes("!important"),
    false,
  );
  assert.match(
    css,
    /\.theme-doc-markdown a:not\(\.hash-link\)\s*\{[^}]*text-decoration-line:\s*underline;/su,
  );
  assert.match(
    css,
    /@media \(min-width: 996px\)\s*\{[\s\S]*?\.navbar__toggle\s*\{[^}]*display:\s*none;[\s\S]*?\.navbar__item\s*\{[^}]*display:\s*inline-block;/u,
  );
  assert.equal(/@import|url\(\s*["']?https?:/u.test(css), false);
  assert.match(
    source("docusaurus.config.ts"),
    /customCss: "\.\/src\/css\/custom\.css"/u,
  );
  assert.match(source("docusaurus.config.ts"), /favicon: "data:,"/u);
});

test("CODE-008 首页主操作在已访问状态保持高对比文本", () => {
  const css = source("src/pages/index.module.css");
  assert.match(css, /\.primaryLink:visited\s*\{/u);
  assert.match(css, /--ifm-link-color:\s*var\(--am-surface\)/u);
  assert.match(css, /--ifm-link-hover-color:\s*var\(--am-surface\)/u);
  assert.match(css, /color:\s*var\(--am-surface\)/u);
});

test("CODE-008 全部站点样式保持零 letter-spacing 基线", () => {
  for (const {path, value} of cssSources()) {
    for (const match of value.matchAll(/letter-spacing:\s*([^;]+);/gu)) {
      assert.equal(match[1]?.trim(), "0", `${path} 不得覆盖非零 letter-spacing`);
    }
  }
});

test("CODE-008 只优先加载项目目录的首张项目预览", () => {
  const projectList = source("src/components/ProjectList/ProjectList.tsx");
  assert.match(projectList, /readonly prioritizeFirstPreview: boolean;/u);
  assert.match(
    projectList,
    /const isPriorityPreview = prioritizeFirstPreview && index === 0;/u,
  );
  assert.match(projectList, /loading=\{isPriorityPreview \? "eager" : "lazy"\}/u);
  assert.match(
    projectList,
    /fetchPriority=\{isPriorityPreview \? "high" : undefined\}/u,
  );
  assert.match(
    source("src/pages/projects/index.tsx"),
    /<ProjectList headingLevel="h2" prioritizeFirstPreview \/>/u,
  );
  assert.match(
    source("src/pages/index.tsx"),
    /<ProjectList headingLevel="h3" prioritizeFirstPreview=\{false\} \/>/u,
  );
});

test("D-034 详情主题覆盖固定三档布局并使用原生内容目录折叠", () => {
  const rootLayout = source("src/theme/DocRoot/Layout/index.tsx");
  const itemLayout = source("src/theme/DocItem/Layout/index.tsx");
  const rootStyles = source("src/theme/DocRoot/Layout/styles.module.css");
  const itemStyles = source("src/theme/DocItem/Layout/styles.module.css");
  const directoryStyles = source(
    "src/components/ContentDirectory/ContentDirectory.module.css",
  );

  assert.match(rootLayout, /<ContentDirectory variant="desktop" \/>/u);
  assert.match(rootLayout, /<ContentDirectory variant="collapsible" \/>/u);
  assert.match(itemLayout, /<details className=\{styles\.mobileToc\}>/u);
  assert.match(itemLayout, /<summary>本页目录<\/summary>/u);
  assert.match(itemLayout, /const filteredToc = toc\.filter/u);
  assert.match(itemLayout, /filteredToc\.length > 0/u);
  assert.match(itemLayout, /toc:\s*filteredToc/u);
  assert.equal(itemLayout.includes("toc.length > 0"), false);
  assert.match(rootStyles, /@media \(min-width: 1280px\)/u);
  assert.match(itemStyles, /@media \(min-width: 996px\)/u);
  assert.match(
    directoryStyles,
    /\.collapsible\s*\{[^}]*display:\s*block;/su,
  );
  assert.match(
    directoryStyles,
    /@media \(min-width: 1280px\)\s*\{[^}]*\.collapsible\s*\{[^}]*display:\s*none;/su,
  );
  assert.equal(directoryStyles.includes("max-width: 1279px"), false);

  const directory = source(
    "src/components/ContentDirectory/ContentDirectory.tsx",
  );
  assert.match(directory, /<details className=\{styles\.collapsible\}>/u);
  assert.match(directory, /<summary>浏览本栏目<\/summary>/u);
  assert.match(directory, /aria-current=\{isCurrent \? "page" : undefined\}/u);
  assert.equal(directory.includes("window"), false);
  assert.equal(directory.includes("document"), false);
});
