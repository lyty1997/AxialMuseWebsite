import type {Config} from "@docusaurus/types";
import type {
  Options as ClassicPresetOptions,
  ThemeConfig,
} from "@docusaurus/preset-classic";
import {readBuildContext} from "./src/build/site-config/index.js";

const buildContext = readBuildContext();
if (buildContext.mode === "preview") {
  throw new Error("[BUILD_MODE_UNAVAILABLE] preview 的 Docusaurus --dev、noindex 与候选激活仍由 #8 接管。");
}

const config: Config = {
  title: "Axial Muse",
  tagline: "个人项目与技术分享",
  favicon: "data:,",
  url: "https://www.axialmuse.com",
  baseUrl: "/",
  trailingSlash: true,
  noIndex: false,
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
        theme: {
          customCss: "./src/css/custom.css",
        },
        sitemap: {},
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
      items: [
        {to: "/projects/", label: "项目", position: "left"},
        {to: "/writing/", label: "技术分享", position: "left"},
        {to: "/#roadmap", label: "路线", position: "left"},
        {to: "/#about", label: "关于", position: "left"},
        {
          href: "https://github.com/lyty1997",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "light",
      links: [
        {
          title: "Axial Muse",
          items: [
            {
              label: "GitHub",
              href: "https://github.com/lyty1997",
            },
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
