import OriginalDocItemMetadata from "@theme-original/DocItem/Metadata";
import {SeoMetadata} from "../../../components/SeoMetadata";
import {useCurrentContentDetail} from "../../../components/SiteContentData";

export default function DocItemMetadata() {
  const detail = useCurrentContentDetail();
  const metadata = detail.kind === "project"
    ? {
        title: `${detail.item.title} | Axial Muse`,
        description: detail.item.summary,
        socialDescription: detail.item.summary,
        canonicalPath: detail.item.canonicalPath,
        type: "website" as const,
        imagePath: detail.item.previewImage.publicUrl,
      }
    : {
        title: `${detail.item.title} | Axial Muse`,
        description: detail.item.seo.description,
        socialDescription: detail.item.seo.socialDescription,
        canonicalPath: detail.item.canonicalPath,
        type: "article" as const,
      };
  return (
    <>
      <OriginalDocItemMetadata />
      <SeoMetadata {...metadata} />
    </>
  );
}
