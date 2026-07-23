import presetClassicImport from "@docusaurus/preset-classic";
import {loadFreshModule} from "@docusaurus/utils";
import sidebars from "../../../sidebars.js";
import {createContentDataPlugin} from "./content-data-plugin.js";
import {
  createClassicDerivedPreset,
  resolveClassicPresetModule,
} from "./docusaurus-preset-factory.js";
import {createProjectPreviewRemarkPlugin} from "./project-preview-projection.js";
import {
  createContentBuildSession,
  sessionSidebarItemsGenerator,
} from "./session.js";

const docusaurusPreset = createClassicDerivedPreset({
  presetClassic: resolveClassicPresetModule(presetClassicImport as unknown),
  loadFreshModule,
  sidebars,
  createContentBuildSession,
  sessionSidebarItemsGenerator,
  sessionProjectPreviewRemarkPlugin: createProjectPreviewRemarkPlugin,
  createContentDataPlugin,
});

export default docusaurusPreset;
