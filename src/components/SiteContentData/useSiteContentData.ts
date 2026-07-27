import {usePluginData} from "@docusaurus/useGlobalData";
import {useLocation} from "@docusaurus/router";
import {
  findSiteContentDetail,
  readSiteContentData,
} from "./contract";
import type {
  SiteContentData,
  SiteContentDetail,
} from "./contract";

const CONTENT_DATA_PLUGIN_NAME = "axial-muse-content-data";

export function useSiteContentData(): SiteContentData {
  return readSiteContentData(usePluginData(CONTENT_DATA_PLUGIN_NAME));
}

export function useCurrentContentDetail(): SiteContentDetail {
  const data = useSiteContentData();
  const location = useLocation();
  return findSiteContentDetail(data, location.pathname);
}
