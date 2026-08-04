import Link from "@docusaurus/Link";
import {
  useCurrentContentDetail,
  useSiteContentData,
} from "../SiteContentData";
import type {
  SiteArticle,
  SiteWritingGroup,
} from "../SiteContentData";
import styles from "./ContentDirectory.module.css";

export interface ContentDirectoryProps {
  readonly variant: "desktop" | "collapsible";
}

function DirectoryLink({
  article,
  currentPath,
}: Readonly<{
  article: SiteArticle;
  currentPath: string;
}>) {
  const isCurrent = article.canonicalPath === currentPath;
  return (
    <Link
      className={`${styles.link} menu__link`}
      to={article.canonicalPath}
      aria-current={isCurrent ? "page" : undefined}
    >
      {article.title}
      {article.publicationStatus === "archived" ? "（归档）" : null}
    </Link>
  );
}

function ArticleItems({
  articles,
  currentPath,
}: Readonly<{
  articles: readonly SiteArticle[];
  currentPath: string;
}>) {
  if (articles.length === 0) return null;
  return (
    <ul className={styles.items}>
      {articles.map((article) => (
        <li className="theme-doc-sidebar-item-link" key={article.articleId}>
          <DirectoryLink article={article} currentPath={currentPath} />
        </li>
      ))}
    </ul>
  );
}

function WritingGroup({
  group,
  currentPath,
}: Readonly<{
  group: SiteWritingGroup;
  currentPath: string;
}>) {
  if (group.kind === "general" || group.kind === "draft") {
    return (
      <li className={styles.group}>
        <p className={styles.groupLabel}>{group.label}</p>
        <ArticleItems articles={group.articles} currentPath={currentPath} />
      </li>
    );
  }
  return (
    <li className={styles.group}>
      <p className={styles.groupLabel}>{group.label}</p>
      <ArticleItems articles={group.rootArticles} currentPath={currentPath} />
      {group.modules.map((module) => (
        <div className={styles.module} key={module.moduleId}>
          <p className={styles.moduleLabel}>{module.label}</p>
          <ArticleItems articles={module.articles} currentPath={currentPath} />
        </div>
      ))}
    </li>
  );
}

function DirectoryNavigation() {
  const data = useSiteContentData();
  const detail = useCurrentContentDetail();
  const currentPath = detail.item.canonicalPath;
  if (detail.kind === "project") {
    return (
      <nav aria-label="项目目录">
        <p className={styles.label}>项目目录</p>
        <ul className={`${styles.items} theme-doc-sidebar-menu menu__list`}>
          {data.projectNavigation.map((project) => (
            <li className="theme-doc-sidebar-item-link" key={project.projectId}>
              <Link
                className={`${styles.link} menu__link`}
                to={project.canonicalPath}
                aria-current={project.canonicalPath === currentPath ? "page" : undefined}
              >
                {project.title}
                {project.publicationStatus === "archived" ? "（归档）" : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    );
  }
  return (
    <nav aria-label="技术分享目录">
      <p className={styles.label}>技术分享目录</p>
      <ul className={`${styles.groups} theme-doc-sidebar-menu menu__list`}>
        {data.writingNavigation.map((group) => (
          <WritingGroup
            key={group.kind === "project" ? `project:${group.projectId}` : group.kind}
            group={group}
            currentPath={currentPath}
          />
        ))}
      </ul>
    </nav>
  );
}

export function ContentDirectory({variant}: ContentDirectoryProps) {
  if (variant === "desktop") {
    return (
      <div className={styles.desktop}>
        <DirectoryNavigation />
      </div>
    );
  }
  return (
    <details className={styles.collapsible}>
      <summary>浏览本栏目</summary>
      <div className={styles.collapsibleContent}>
        <DirectoryNavigation />
      </div>
    </details>
  );
}
