import Link from "@docusaurus/Link";
import {useHistory, useLocation} from "@docusaurus/router";
import NavbarLogo from "@theme/Navbar/Logo";
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  siteArticles,
  useSiteContentData,
} from "../SiteContentData";
import styles from "./SiteHeader.module.css";

interface SearchEntry {
  readonly kind: "project" | "writing";
  readonly title: string;
  readonly summary: string;
  readonly canonicalPath: string;
  readonly searchableText: string;
}

interface SectionLink {
  readonly label: string;
  readonly path: "/" | "/projects/" | "/writing/";
  readonly icon: ReactNode;
}

function Icon({
  children,
}: Readonly<{children: ReactNode}>) {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const SECTION_LINKS: readonly SectionLink[] = Object.freeze([
  {
    label: "首页",
    path: "/",
    icon: (
      <Icon>
        <path d="M4 10.5 12 4l8 6.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" />
        <path d="M9.5 20v-6h5v6" />
      </Icon>
    ),
  },
  {
    label: "项目介绍",
    path: "/projects/",
    icon: (
      <Icon>
        <path d="M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5z" />
        <path d="M13 16h6M16 13v6" />
      </Icon>
    ),
  },
  {
    label: "踩过的坑",
    path: "/writing/",
    icon: (
      <Icon>
        <path d="M4 17.5c3-5 5.5-7.5 9-7.5 2.6 0 4.6 1.2 7 4" />
        <path d="M4 13.5h4v4H4zM16 4h4v4h-4z" />
        <path d="m16 18 2 2 3-4" />
      </Icon>
    ),
  },
]);

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function isCurrentSection(pathname: string, path: SectionLink["path"]): boolean {
  if (path === "/") return pathname === "/";
  return pathname === path.slice(0, -1) || pathname.startsWith(path);
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.5 15.5 4 4" />
    </svg>
  );
}

function SiteSearch() {
  const data = useSiteContentData();
  const history = useHistory();
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchEntries = useMemo<readonly SearchEntry[]>(() => {
    const projects = data.projectNavigation
      .filter((project) => (
        project.publicationStatus === "published"
        || project.publicationStatus === "archived"
      ))
      .map((project) => ({
        kind: "project" as const,
        title: project.title,
        summary: project.summary,
        canonicalPath: project.canonicalPath,
        searchableText: normalizeSearchText(`${project.title} ${project.summary}`),
      }));
    const writing = siteArticles(data)
      .filter((article) => article.publicationStatus !== "draft")
      .map((article) => ({
        kind: "writing" as const,
        title: article.title,
        summary: article.summary,
        canonicalPath: article.canonicalPath,
        searchableText: normalizeSearchText(`${article.title} ${article.summary}`),
      }));
    return Object.freeze([...projects, ...writing]);
  }, [data]);
  const normalizedQuery = normalizeSearchText(query);
  const results = useMemo(() => {
    const terms = normalizedQuery.split(/\s+/u).filter(Boolean);
    if (terms.length === 0) return Object.freeze([]) as readonly SearchEntry[];
    return Object.freeze(searchEntries
      .filter((entry) => terms.every((term) => entry.searchableText.includes(term)))
      .slice(0, 6));
  }, [normalizedQuery, searchEntries]);
  const hasQuery = normalizedQuery.length > 0;
  const selectedIndex = results.length === 0
    ? 0
    : Math.min(activeIndex, results.length - 1);

  useEffect(() => {
    setQuery("");
    setActiveIndex(0);
  }, [location.pathname]);

  const openResult = (entry: SearchEntry | undefined): void => {
    if (entry === undefined) return;
    setQuery("");
    setActiveIndex(0);
    history.push(entry.canonicalPath);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    openResult(results[selectedIndex]);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      if (query.length === 0) return;
      event.preventDefault();
      setQuery("");
      setActiveIndex(0);
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + results.length) % results.length);
    }
  };

  return (
    <form className={styles.search} role="search" onSubmit={handleSubmit}>
      <div className={styles.searchField}>
        <SearchIcon />
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="搜索项目与踩坑记录"
          aria-label="搜索公开项目和文章"
          aria-autocomplete="list"
          aria-controls="site-search-results"
          aria-expanded={hasQuery}
          aria-activedescendant={
            results.length === 0
              ? undefined
              : `site-search-result-${selectedIndex}`
          }
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          aria-label="打开搜索结果"
          disabled={results.length === 0}
        >
          <span aria-hidden="true">↵</span>
        </button>
      </div>
      {hasQuery
        ? (
          <div
            id="site-search-results"
            className={styles.searchResults}
            role="listbox"
            aria-label="搜索结果"
          >
            {results.length === 0
              ? <p className={styles.noResults}>没有找到已公开内容</p>
              : results.map((entry, index) => (
                <Link
                  id={`site-search-result-${index}`}
                  className={
                    index === selectedIndex
                      ? `${styles.result} ${styles.resultActive}`
                      : styles.result
                  }
                  key={entry.canonicalPath}
                  role="option"
                  aria-selected={index === selectedIndex}
                  to={entry.canonicalPath}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    setQuery("");
                    setActiveIndex(0);
                  }}
                >
                  <span className={styles.resultKind}>
                    {entry.kind === "project" ? "项目介绍" : "踩过的坑"}
                  </span>
                  <strong>{entry.title}</strong>
                  <span className={styles.resultSummary}>{entry.summary}</span>
                </Link>
              ))}
          </div>
        )
        : null}
    </form>
  );
}

export function SiteHeader() {
  const location = useLocation();
  return (
    <div className={styles.header}>
      <div className={styles.topRow}>
        <NavbarLogo />
        <SiteSearch />
      </div>
      <div className={styles.tabs} aria-label="内容导航">
        {SECTION_LINKS.map((entry) => {
          const active = isCurrentSection(location.pathname, entry.path);
          return (
            <Link
              className={active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              key={entry.path}
              to={entry.path}
              aria-current={active ? "page" : undefined}
            >
              {entry.icon}
              <span>{entry.label}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
