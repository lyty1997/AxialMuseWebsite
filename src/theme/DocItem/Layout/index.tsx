import type {ReactNode} from "react";
import {useDoc} from "@docusaurus/plugin-content-docs/client";
import ContentVisibility from "@theme/ContentVisibility";
import DocBreadcrumbs from "@theme/DocBreadcrumbs";
import DocItemContent from "@theme/DocItem/Content";
import DocItemFooter from "@theme/DocItem/Footer";
import DocItemPaginator from "@theme/DocItem/Paginator";
import DocVersionBadge from "@theme/DocVersionBadge";
import DocVersionBanner from "@theme/DocVersionBanner";
import TOCItems from "@theme/TOCItems";
import styles from "./styles.module.css";

export interface DocItemLayoutProps {
  readonly children: ReactNode;
}

export default function DocItemLayout({children}: DocItemLayoutProps) {
  const {frontMatter, metadata, toc} = useDoc();
  const hasToc = frontMatter.hide_table_of_contents !== true && toc.length > 0;
  const tocProps = {
    toc,
    minHeadingLevel: frontMatter.toc_min_heading_level,
    maxHeadingLevel: frontMatter.toc_max_heading_level,
  };

  return (
    <div className={styles.layout}>
      <div className={styles.contentColumn}>
        <ContentVisibility metadata={metadata} />
        <DocVersionBanner />
        <article className={styles.article}>
          <DocBreadcrumbs />
          <DocVersionBadge />
          {hasToc
            ? (
              <details className={styles.mobileToc}>
                <summary>本页目录</summary>
                <nav className={styles.mobileTocContent} aria-label="本页目录">
                  <TOCItems {...tocProps} linkClassName={styles.tocLink} />
                </nav>
              </details>
            )
            : null}
          <DocItemContent>{children}</DocItemContent>
          <DocItemFooter />
        </article>
        <DocItemPaginator />
      </div>
      {hasToc
        ? (
          <aside className={styles.desktopToc} aria-label="本页目录">
            <p className={styles.tocLabel}>本页目录</p>
            <TOCItems {...tocProps} linkClassName={styles.tocLink} />
          </aside>
        )
        : null}
    </div>
  );
}
