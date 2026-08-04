import Link from "@docusaurus/Link";
import {useCurrentContentDetail} from "../SiteContentData";
import type {SiteContentLink} from "../SiteContentData";
import styles from "./ContentMeta.module.css";

const PROJECT_STATUS = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  archived: "已归档",
} as const;

const PROJECT_PUBLICATION_STATUS = {
  draft: "草稿预览",
  planned: "计划预览",
} as const;

function RelatedLinks({
  label,
  links,
}: Readonly<{
  label: "相关技术分享" | "相关项目" | "相关文章";
  links: readonly SiteContentLink[];
}>) {
  if (links.length === 0) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <ul aria-label={label}>
          {links.map((link) => (
            <li key={link.canonicalPath}>
              <Link to={link.canonicalPath}>{link.title}</Link>
            </li>
          ))}
        </ul>
      </dd>
    </>
  );
}

export function ContentMeta() {
  const detail = useCurrentContentDetail();
  if (detail.kind === "project") {
    const project = detail.item;
    return (
      <div className={styles.meta}>
        <p className={styles.summary}>{project.summary}</p>
        <dl className={styles.details} aria-label="项目资料">
          <dt>项目状态</dt>
          <dd>{PROJECT_STATUS[project.status]}</dd>
          {project.publicationStatus === "archived"
            ? (
              <>
                <dt>公开状态</dt>
                <dd>已归档</dd>
              </>
            )
            : null}
          {project.publicationStatus === "draft" || project.publicationStatus === "planned"
            ? (
              <>
                <dt>公开状态</dt>
                <dd>{PROJECT_PUBLICATION_STATUS[project.publicationStatus]}</dd>
              </>
            )
            : null}
          <dt>最近更新</dt>
          <dd><time dateTime={project.updatedAt}>{project.updatedAt}</time></dd>
          {project.repositoryUrl === undefined
            ? null
            : (
              <>
                <dt>公开仓库</dt>
                <dd>
                  <a href={project.repositoryUrl}>查看源码</a>
                </dd>
              </>
            )}
          <RelatedLinks
            label="相关技术分享"
            links={project.relatedWriting}
          />
        </dl>
      </div>
    );
  }

  const article = detail.item;
  return (
    <div className={styles.meta}>
      <p className={styles.summary}>{article.summary}</p>
      <dl className={styles.details} aria-label="文章资料">
        <dt>作者</dt>
        <dd>{article.authors.map((author) => author.displayName).join("、")}</dd>
        {article.publicationStatus === "draft"
          ? (
            <>
              <dt>公开状态</dt>
              <dd>草稿预览</dd>
            </>
          )
          : (
            <>
              <dt>发布于</dt>
              <dd><time dateTime={article.publishedAt}>{article.publishedAt}</time></dd>
            </>
          )}
        {article.updatedAt === undefined
          ? null
          : (
            <>
              <dt>更新于</dt>
              <dd><time dateTime={article.updatedAt}>{article.updatedAt}</time></dd>
            </>
          )}
        <dt>主题</dt>
        <dd>{article.topics.map((topic) => topic.displayName).join("、")}</dd>
        {article.publicationStatus === "archived"
          ? (
            <>
              <dt>公开状态</dt>
              <dd>已归档</dd>
            </>
          )
          : null}
        <RelatedLinks label="相关项目" links={article.relatedProjects} />
        <RelatedLinks label="相关文章" links={article.relatedArticles} />
      </dl>
    </div>
  );
}
