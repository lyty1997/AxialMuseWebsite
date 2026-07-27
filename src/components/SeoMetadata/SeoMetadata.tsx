import Head from "@docusaurus/Head";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import {resolveSeoMetadata} from "./contract";
import type {SeoMetadataValues} from "./contract";

export function SeoMetadata(props: SeoMetadataValues) {
  const {siteConfig} = useDocusaurusContext();
  const metadata = resolveSeoMetadata({
    ...props,
    origin: siteConfig.url,
  });
  return (
    <Head>
      <title>{metadata.title}</title>
      <meta name="description" content={metadata.description} />
      <link rel="canonical" href={metadata.canonicalUrl} />
      <meta property="og:title" content={metadata.title} />
      <meta property="og:description" content={metadata.socialDescription} />
      <meta property="og:url" content={metadata.canonicalUrl} />
      <meta property="og:type" content={metadata.type} />
      {metadata.imageUrl === undefined
        ? null
        : <meta property="og:image" content={metadata.imageUrl} />}
    </Head>
  );
}
