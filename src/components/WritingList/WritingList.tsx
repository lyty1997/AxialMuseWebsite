import Link from "@docusaurus/Link";
import {
  siteArticles,
  useSiteContentData,
} from "../SiteContentData";
import type {
  SiteArticle,
  SiteWritingGroup,
} from "../SiteContentData";

const EMPTY_WRITING = "技术分享正在从项目记录中整理。首批内容发布后会在这里提供可核验的原始资料与实现细节。";

export interface WritingListProps {
  readonly groupHeadingLevel: "h2" | "h3";
}

function ArticleList({
  articles,
  headingLevel,
}: Readonly<{
  articles: readonly SiteArticle[];
  headingLevel: "h3" | "h4" | "h5";
}>) {
  const Heading = headingLevel;
  return (
    <ul>
      {articles.map((article) => (
        <li key={article.articleId}>
          <article>
            <Heading>
              <Link to={article.canonicalPath}>{article.title}</Link>
            </Heading>
            <p>{article.summary}</p>
            <p>作者：{article.authors.map((author) => author.displayName).join("、")}</p>
            {article.publicationStatus === "draft"
              ? <p>草稿预览</p>
              : (
                <p>
                  发布于 <time dateTime={article.publishedAt}>{article.publishedAt}</time>
                  {" · "}
                  更新于 <time dateTime={article.updatedAt}>{article.updatedAt}</time>
                  {article.publicationStatus === "archived" ? " · 已归档" : null}
                </p>
              )}
            <p>主题：{article.topics.map((topic) => topic.displayName).join("、")}</p>
          </article>
        </li>
      ))}
    </ul>
  );
}

function WritingGroup({
  group,
  headingLevel,
}: Readonly<{
  group: SiteWritingGroup;
  headingLevel: "h2" | "h3";
}>) {
  const Heading = headingLevel;
  const articleHeadingLevel = headingLevel === "h2" ? "h3" : "h4";
  if (group.kind === "general" || group.kind === "draft") {
    return (
      <section>
        <Heading>{group.label}</Heading>
        <ArticleList
          articles={group.articles}
          headingLevel={articleHeadingLevel}
        />
      </section>
    );
  }
  return (
    <section>
      <Heading>{group.label}</Heading>
      {group.rootArticles.length === 0
        ? null
        : (
          <ArticleList
            articles={group.rootArticles}
            headingLevel={articleHeadingLevel}
          />
        )}
      {group.modules.map((module) => (
        <section key={module.moduleId}>
          {headingLevel === "h2"
            ? <h3>{module.label}</h3>
            : <h4>{module.label}</h4>}
          <ArticleList
            articles={module.articles}
            headingLevel={headingLevel === "h2" ? "h4" : "h5"}
          />
        </section>
      ))}
    </section>
  );
}

export function WritingList({groupHeadingLevel}: WritingListProps) {
  const data = useSiteContentData();
  if (siteArticles(data).length === 0) return <p>{EMPTY_WRITING}</p>;
  return (
    <>
      {data.writingNavigation.map((group) => (
        <WritingGroup
          key={group.kind === "project" ? `project:${group.projectId}` : group.kind}
          group={group}
          headingLevel={groupHeadingLevel}
        />
      ))}
    </>
  );
}
