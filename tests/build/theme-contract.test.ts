import assert from "node:assert/strict";
import {readFileSync, realpathSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";

const ROOT = realpathSync(process.cwd());

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
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
  assert.equal(css.includes("!important"), false);
  assert.equal(/@import|url\(\s*["']?https?:/u.test(css), false);
  assert.match(
    source("docusaurus.config.ts"),
    /customCss: "\.\/src\/css\/custom\.css"/u,
  );
});

test("CODE-008 首页主操作在已访问状态保持高对比文本", () => {
  const css = source("src/pages/index.module.css");
  assert.match(css, /\.primaryLink:visited\s*\{/u);
  assert.match(css, /--ifm-link-color:\s*var\(--am-surface\)/u);
  assert.match(css, /--ifm-link-hover-color:\s*var\(--am-surface\)/u);
  assert.match(css, /color:\s*var\(--am-surface\)/u);
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
  assert.match(itemLayout, /toc\.length > 0/u);
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
