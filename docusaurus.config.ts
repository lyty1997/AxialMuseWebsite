import type {Config} from "@docusaurus/types";
import type {
  Options as ClassicPresetOptions,
  ThemeConfig,
} from "@docusaurus/preset-classic";
import {readBuildContext} from "./src/build/site-config/index.js";

const buildContext = readBuildContext();
const isPreview = buildContext.mode === "preview";

const config: Config = {
  title: "Axial Muse",
  tagline: "用全栈技术与 AI 推动生产力平权",
  favicon: "assets/brand/axial-muse-mark.png",
  url: "https://www.axialmuse.com",
  baseUrl: "/",
  trailingSlash: true,
  noIndex: isPreview,
  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  onDuplicateRoutes: "throw",
  future: {
    v4: true,
    faster: true,
  },
  i18n: {
    defaultLocale: "zh-CN",
    locales: ["zh-CN"],
    localeConfigs: {
      "zh-CN": {
        label: "简体中文",
        htmlLang: "zh-CN",
      },
    },
  },
  staticDirectories: [],
  presets: [
    [
      "./src/build/content/docusaurus-preset.ts",
      {
        blog: false,
        debug: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
        sitemap: isPreview ? false : {},
      } satisfies Omit<ClassicPresetOptions, "docs">,
    ],
  ],
  themeConfig: {
    colorMode: {
      defaultMode: "light",
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: "Axial Muse",
      logo: {
        alt: "Axial Muse 标志",
        src: "assets/brand/axial-muse-mark.png",
        width: 38,
        height: 38,
      },
      items: [],
    },
    footer: {
      style: "light",
      links: [
        {
          title: "Axial Muse",
          items: [
            {
              label: "沪ICP备2026029086号",
              href: "https://beian.miit.gov.cn/",
            },
          ],
        },
      ],
      copyright: "2026 Axial Muse",
    },
  } satisfies ThemeConfig,
};

export default config;
