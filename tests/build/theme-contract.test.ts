import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync, readdirSync, realpathSync} from "node:fs";
import {relative, resolve} from "node:path";
import test from "node:test";

const ROOT = realpathSync(process.cwd());

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function relativeLuminance(hex: string): number {
  assert.match(hex, /^#[0-9a-f]{6}$/u);
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
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
    "--am-canvas": "#f4eddf",
    "--am-surface": "#fffcf6",
    "--am-ink": "#16242e",
    "--am-muted": "#59636b",
    "--am-line": "#d8ceba",
    "--am-line-strong": "#938772",
    "--am-brand": "#153a5b",
    "--am-accent": "#2b6995",
    "--am-accent-soft": "#e5edf2",
    "--am-signal": "#985932",
  };
  for (const [name, value] of Object.entries(expectedTokens)) {
    assert.ok(css.includes(`${name}: ${value};`));
  }
  for (const [label, first, second, minimum] of [
    ["正文/页面", expectedTokens["--am-ink"], expectedTokens["--am-canvas"], 4.5],
    ["辅助文字/页面", expectedTokens["--am-muted"], expectedTokens["--am-canvas"], 4.5],
    ["品牌蓝/页面", expectedTokens["--am-brand"], expectedTokens["--am-canvas"], 4.5],
    ["交互蓝/页面", expectedTokens["--am-accent"], expectedTokens["--am-canvas"], 4.5],
    ["交互蓝/内容表面", expectedTokens["--am-accent"], expectedTokens["--am-surface"], 4.5],
    ["交互蓝/浅蓝状态面", expectedTokens["--am-accent"], expectedTokens["--am-accent-soft"], 4.5],
    ["控件边界/页面", expectedTokens["--am-line-strong"], expectedTokens["--am-canvas"], 3],
    ["提示色/页面", expectedTokens["--am-signal"], expectedTokens["--am-canvas"], 4.5],
  ] as const) {
    assert.ok(
      contrastRatio(first, second) >= minimum,
      `${label} 对比度不得低于 ${minimum}:1`,
    );
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
  assert.match(
    source("docusaurus.config.ts"),
    /favicon: "assets\/brand\/axial-muse-mark\.png"/u,
  );
});

test("D-151 选定的书架之门 A Logo 字节固定且不含 PNG 元数据", () => {
  const logo = readFileSync(resolve(ROOT, "static-public/assets/brand/axial-muse-mark.png"));
  const css = source("src/css/custom.css");
  const headerCss = source("src/components/SiteHeader/SiteHeader.module.css");
  assert.equal(
    createHash("sha256").update(logo).digest("hex"),
    "a5ee5de5e63b2ec3b43ba9d06e980fcc58423aab8e6a8100b2c86cdc221b6a77",
  );
  assert.equal(logo.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(logo.readUInt32BE(16), 1254);
  assert.equal(logo.readUInt32BE(20), 1254);
  const chunks: string[] = [];
  let offset = 8;
  while (offset < logo.length) {
    const length = logo.readUInt32BE(offset);
    chunks.push(logo.subarray(offset + 4, offset + 8).toString("ascii"));
    offset += length + 12;
  }
  assert.equal(offset, logo.length);
  assert.deepEqual([...new Set(chunks)].sort(), ["IDAT", "IEND", "IHDR"]);
  assert.equal(chunks.filter((chunk) => chunk === "IHDR").length, 1);
  assert.equal(chunks.filter((chunk) => chunk === "IEND").length, 1);
  assert.match(
    headerCss,
    /:global\(#__docusaurus#__docusaurus\) \.topRow :global\(\.navbar__logo img\)\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*contain;/su,
  );
  assert.match(
    css,
    /--ifm-navbar-background-color:\s*rgb\(255 252 246 \/ 96%\);/u,
  );
  assert.match(
    css,
    /#__docusaurus#__docusaurus \.navbar\s*\{[^}]*background:\s*rgb\(255 252 246 \/ 96%\);/su,
  );
  assert.equal(
    /#(?:0b756b|e4f3f1|2b887d|10232a|f3f6f8|6673c5)\b/iu
      .test(css),
    false,
  );
});

test("D-144 首页不重复项目/文章入口且页脚不重复 GitHub", () => {
  const home = source("src/pages/index.tsx");
  const config = source("docusaurus.config.ts");
  assert.equal(/\b(?:ProjectList|WritingList|heroActions)\b/u.test(home), false);
  assert.equal(/to="\/(?:projects|writing)\/"/u.test(home), false);
  assert.equal(/label: "GitHub"/u.test(config), false);
  assert.match(config, /label: "沪ICP备2026029086号"/u);
});

test("D-141 正文保持自然字距，品牌标签使用局部字距且不引入远程资源", () => {
  const globalCss = source("src/css/custom.css");
  const headerCss = source("src/components/SiteHeader/SiteHeader.module.css");
  const homeCss = source("src/pages/index.module.css");
  assert.match(globalCss, /body\s*\{[^}]*letter-spacing:\s*0;/su);
  assert.match(headerCss, /\.resultKind\s*\{[^}]*letter-spacing:\s*0\.08em;/su);
  assert.match(homeCss, /\.eyebrow,[\s\S]*?letter-spacing:\s*0\.14em;/u);
  for (const {path, value} of cssSources()) {
    assert.equal(
      /@import|url\(\s*["']?https?:/u.test(value),
      false,
      `${path} 不得加载远程 CSS 或字体资源`,
    );
  }
});

test("D-141 页头搜索只匹配公开安全投影且不持久化查询", () => {
  const header = source("src/components/SiteHeader/SiteHeader.tsx");
  const config = source("docusaurus.config.ts");
  const registry = source("docs/contracts/static-public-assets.json");
  assert.match(header, /project\.publicationStatus === "published"/u);
  assert.match(header, /project\.publicationStatus === "archived"/u);
  assert.match(header, /article\.publicationStatus !== "draft"/u);
  assert.match(header, /useState\(""\)/u);
  assert.match(header, /slice\(0, 6\)/u);
  assert.equal(
    /\b(?:fetch|localStorage|sessionStorage)\b|document\.cookie/u.test(header),
    false,
  );
  assert.match(header, /label: "首页"/u);
  assert.match(header, /label: "项目介绍"/u);
  assert.match(header, /label: "踩过的坑"/u);
  assert.match(config, /items: \[\]/u);
  assert.equal(/登录|注册/u.test(config), false);
  assert.match(
    registry,
    /"sourcePath": "assets\/brand\/axial-muse-mark\.png"[\s\S]*?"role": "brand"/u,
  );
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
  assert.equal(
    /<ProjectList/u.test(source("src/pages/index.tsx")),
    false,
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

test("D-034 小屏导航包装只补 Escape 关闭与焦点归还", () => {
  const navbarLayout = source("src/theme/Navbar/Layout/index.tsx");
  assert.match(
    navbarLayout,
    /import OriginalNavbarLayout from "@theme-original\/Navbar\/Layout";/u,
  );
  assert.match(navbarLayout, /event\.key !== "Escape"/u);
  assert.match(
    navbarLayout,
    /document\.addEventListener\("keydown", closeOnEscape\)/u,
  );
  assert.match(navbarLayout, /closeButton\.click\(\);/u);
  assert.match(
    navbarLayout,
    /requestAnimationFrame\(\(\) => toggleButton\.focus\(\)\);/u,
  );
  assert.match(
    navbarLayout,
    /document\.removeEventListener\("keydown", closeOnEscape\)/u,
  );
  assert.equal(navbarLayout.includes("@docusaurus/theme-common/internal"), false);
});
