import Link from "@docusaurus/Link";
import {useSiteContentData} from "../SiteContentData";
import styles from "./ProjectList.module.css";

const EMPTY_PROJECTS = "当前还没有完成公开审核的项目。项目资料通过事实、隐私和视觉证据检查后会在这里出现。";

const PROJECT_STATUS = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  archived: "已归档",
} as const;

export interface ProjectListProps {
  readonly headingLevel: "h2" | "h3";
  readonly prioritizeFirstPreview: boolean;
}

export function ProjectList({
  headingLevel,
  prioritizeFirstPreview,
}: ProjectListProps) {
  const {projectNavigation} = useSiteContentData();
  if (projectNavigation.length === 0) {
    return <p className={styles.emptyState}>{EMPTY_PROJECTS}</p>;
  }

  const Heading = headingLevel;
  return (
    <ul className={styles.list}>
      {projectNavigation.map((project, index) => {
        const isPriorityPreview = prioritizeFirstPreview && index === 0;
        return (
          <li className={styles.item} key={project.projectId}>
            <article className={styles.card}>
              <img
                className={styles.preview}
                src={project.previewImage.publicUrl}
                width={project.previewImage.width}
                height={project.previewImage.height}
                alt={project.previewImage.alt}
                loading={isPriorityPreview ? "eager" : "lazy"}
                fetchPriority={isPriorityPreview ? "high" : undefined}
                decoding="async"
              />
              <Heading className={styles.title}>
                <Link to={project.canonicalPath}>{project.title}</Link>
              </Heading>
              <p className={styles.status}>项目状态：{PROJECT_STATUS[project.status]}</p>
              {project.publicationStatus === "archived"
                ? <p className={styles.status}>公开状态：已归档</p>
                : null}
              <p className={styles.summary}>{project.summary}</p>
              <p className={styles.updated}>
                最近更新：
                <time dateTime={project.updatedAt}>{project.updatedAt}</time>
              </p>
              <p className={styles.actions}>
                <Link to={project.canonicalPath}>查看项目</Link>
                {project.repositoryUrl === undefined
                  ? null
                  : (
                    <>
                      {" · "}
                      <a href={project.repositoryUrl}>查看源码</a>
                    </>
                  )}
              </p>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
