import assert from "node:assert/strict";
import test from "node:test";
import {
  ArticleDateEditError,
  formatShanghaiDate,
  planArticleDateEdit,
} from "../../scripts/author/lib/article-date-edit.mjs";

function decoded(frontMatter, content = "\n## 正文\n") {
  return Object.freeze({
    content,
    frontMatter: Object.freeze(frontMatter),
  });
}

function expectCode(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ArticleDateEditError);
    assert.equal(error.code, code);
    assert.equal(error.stack, undefined);
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
}

const PUBLISH_SOURCE = [
  "---",
  'articleId: "018f0000-0000-7000-8000-000000000001"',
  'publicationStatus: "published"',
  "metadata:",
  '  publishedAt: "nested-published"',
  '  updatedAt: "nested-updated"',
  "---",
  "",
  "## 正文",
  "",
  'publishedAt: "body-example"',
  'updatedAt: "body-example"',
  "",
].join("\n");

const PUBLISHED_FRONT_MATTER = Object.freeze({
  articleId: "018f0000-0000-7000-8000-000000000001",
  publicationStatus: "published",
  metadata: Object.freeze({
    publishedAt: "nested-published",
    updatedAt: "nested-updated",
  }),
});

function reviseSource({
  publishedAt = "2026-07-20",
  updatedAt = "2026-07-27",
} = {}) {
  return [
    "---",
    'articleId: "018f0000-0000-7000-8000-000000000001"',
    'publicationStatus: "published"',
    `publishedAt: "${publishedAt}"`,
    `updatedAt: "${updatedAt}"`,
    "metadata:",
    '  publishedAt: "nested-published"',
    '  updatedAt: "nested-updated"',
    "---",
    "",
    "## 正文",
    "",
    'publishedAt: "body-example"',
    'updatedAt: "body-example"',
    "",
  ].join("\n");
}

function reviseDecoded({
  publishedAt = "2026-07-20",
  updatedAt = "2026-07-27",
} = {}) {
  return decoded({
    articleId: "018f0000-0000-7000-8000-000000000001",
    publicationStatus: "published",
    publishedAt,
    updatedAt,
    metadata: Object.freeze({
      publishedAt: "nested-published",
      updatedAt: "nested-updated",
    }),
  });
}

test("D-106 Shanghai formatter crosses the UTC date boundary exactly once", () => {
  assert.equal(
    formatShanghaiDate(Date.UTC(2026, 6, 27, 15, 59, 59, 999)),
    "2026-07-27",
  );
  assert.equal(
    formatShanghaiDate(Date.UTC(2026, 6, 27, 16, 0, 0, 0)),
    "2026-07-28",
  );
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    "2026-07-28",
    8_640_000_000_000_001,
  ]) {
    expectCode(() => formatShanghaiDate(value), "AUTHOR_DATE_CLOCK");
  }
});

test("D-106 publish inserts only two canonical top-level lines after status", () => {
  const result = planArticleDateEdit({
    action: "publish",
    decoded: decoded(PUBLISHED_FRONT_MATTER),
    fileContent: PUBLISH_SOURCE,
    today: "2026-07-28",
  });
  const expected = PUBLISH_SOURCE.replace(
    'publicationStatus: "published"',
    [
      'publicationStatus: "published"',
      'publishedAt: "2026-07-28"',
      'updatedAt: "2026-07-28"',
    ].join("\n"),
  );
  assert.deepEqual(result, {
    articleId: "018f0000-0000-7000-8000-000000000001",
    changed: true,
    fileContent: expected,
    publishedAt: "2026-07-28",
    updatedAt: "2026-07-28",
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(
    result.fileContent.slice(result.fileContent.indexOf("---\n", 4)),
    expected.slice(expected.indexOf("---\n", 4)),
  );
  assert.match(result.fileContent, /  publishedAt: "nested-published"/u);
  assert.match(result.fileContent, /^publishedAt: "body-example"$/mu);
});

test("D-106 revise preserves publishedAt, nested fields and body bytes", () => {
  const source = reviseSource();
  const result = planArticleDateEdit({
    action: "revise",
    decoded: reviseDecoded(),
    fileContent: source,
    today: "2026-07-28",
  });
  const expected = source.replace(
    'updatedAt: "2026-07-27"\nmetadata:',
    'updatedAt: "2026-07-28"\nmetadata:',
  );
  assert.deepEqual(result, {
    articleId: "018f0000-0000-7000-8000-000000000001",
    changed: true,
    fileContent: expected,
    publishedAt: "2026-07-20",
    updatedAt: "2026-07-28",
  });
  assert.match(result.fileContent, /^publishedAt: "2026-07-20"$/mu);
  assert.match(result.fileContent, /  updatedAt: "nested-updated"/u);
  assert.match(result.fileContent, /^updatedAt: "body-example"$/mu);
});

test("D-106 same-day revise is an exact no-write plan", () => {
  const source = reviseSource();
  assert.deepEqual(
    planArticleDateEdit({
      action: "revise",
      decoded: reviseDecoded(),
      fileContent: source,
      today: "2026-07-27",
    }),
    {
      articleId: "018f0000-0000-7000-8000-000000000001",
      changed: false,
      fileContent: source,
      publishedAt: "2026-07-20",
      updatedAt: "2026-07-27",
    },
  );
});

test("D-106 clock validation rejects invalid and regressing dates", () => {
  const source = reviseSource();
  for (const today of [
    "2026-02-30",
    "0000-01-01",
    "2026-7-28",
    "2026-07-19",
    "2026-07-26",
  ]) {
    expectCode(
      () => planArticleDateEdit({
        action: "revise",
        decoded: reviseDecoded(),
        fileContent: source,
        today,
      }),
      "AUTHOR_DATE_CLOCK",
    );
  }
});

test("D-106 publish and revise reject disallowed states and date shapes", () => {
  for (const publicationStatus of ["draft", "archived"]) {
    const source = PUBLISH_SOURCE.replace(
      'publicationStatus: "published"',
      `publicationStatus: "${publicationStatus}"`,
    );
    expectCode(
      () => planArticleDateEdit({
        action: "publish",
        decoded: decoded({...PUBLISHED_FRONT_MATTER, publicationStatus}),
        fileContent: source,
        today: "2026-07-28",
      }),
      "AUTHOR_DATE_STATE",
    );
  }

  for (const frontMatter of [
    {...PUBLISHED_FRONT_MATTER, publishedAt: "2026-07-28"},
    {...PUBLISHED_FRONT_MATTER, updatedAt: "2026-07-28"},
    {
      ...PUBLISHED_FRONT_MATTER,
      publishedAt: "2026-07-28",
      updatedAt: "2026-07-28",
    },
  ]) {
    const dateLines = [
      ...(Object.hasOwn(frontMatter, "publishedAt")
        ? [`publishedAt: "${frontMatter.publishedAt}"`]
        : []),
      ...(Object.hasOwn(frontMatter, "updatedAt")
        ? [`updatedAt: "${frontMatter.updatedAt}"`]
        : []),
    ].join("\n");
    const source = PUBLISH_SOURCE.replace(
      'publicationStatus: "published"',
      `publicationStatus: "published"\n${dateLines}`,
    );
    expectCode(
      () => planArticleDateEdit({
        action: "publish",
        decoded: decoded(frontMatter),
        fileContent: source,
        today: "2026-07-28",
      }),
      "AUTHOR_DATE_STATE",
    );
  }

  for (const fixture of [
    {publishedAt: "2026-02-30", updatedAt: "2026-07-27"},
    {publishedAt: "2026-07-28", updatedAt: "2026-07-27"},
  ]) {
    expectCode(
      () => planArticleDateEdit({
        action: "revise",
        decoded: reviseDecoded(fixture),
        fileContent: reviseSource(fixture),
        today: "2026-07-29",
      }),
      "AUTHOR_DATE_STATE",
    );
  }
  expectCode(
    () => planArticleDateEdit({
      action: "remove",
      decoded: decoded(PUBLISHED_FRONT_MATTER),
      fileContent: PUBLISH_SOURCE,
      today: "2026-07-28",
    }),
    "AUTHOR_DATE_STATE",
  );
});

test("D-106 source layout rejects noncanonical, duplicate, CR, BOM and mismatch", () => {
  const cases = [
    {
      decoded: decoded(PUBLISHED_FRONT_MATTER),
      source: PUBLISH_SOURCE.replace(
        'publicationStatus: "published"',
        "publicationStatus: published",
      ),
    },
    {
      decoded: reviseDecoded(),
      source: reviseSource().replace(
        'updatedAt: "2026-07-27"',
        "updatedAt: '2026-07-27'",
      ),
    },
    {
      decoded: reviseDecoded(),
      source: reviseSource().replace(
        'updatedAt: "2026-07-27"',
        'updatedAt : "2026-07-27"',
      ),
    },
    {
      decoded: reviseDecoded(),
      source: reviseSource().replace(
        'updatedAt: "2026-07-27"',
        'updatedAt: "2026-07-27" # comment',
      ),
    },
    {
      decoded: reviseDecoded(),
      source: reviseSource().replace(
        'updatedAt: "2026-07-27"',
        'updatedAt: "2026-07-27"\nupdatedAt: "2026-07-27"',
      ),
    },
    {
      decoded: reviseDecoded({updatedAt: "2026-07-26"}),
      source: reviseSource(),
    },
    {
      decoded: decoded(PUBLISHED_FRONT_MATTER),
      source: PUBLISH_SOURCE.replaceAll("\n", "\r\n"),
    },
    {
      decoded: decoded(PUBLISHED_FRONT_MATTER),
      source: `\uFEFF${PUBLISH_SOURCE}`,
    },
    {
      decoded: decoded(PUBLISHED_FRONT_MATTER),
      source: PUBLISH_SOURCE.replace("---\n", "title: no-frontmatter\n"),
    },
    {
      decoded: decoded(PUBLISHED_FRONT_MATTER),
      source: PUBLISH_SOURCE.replace("\n---\n", "\n...\n"),
    },
  ];
  for (const fixture of cases) {
    expectCode(
      () => planArticleDateEdit({
        action: fixture.decoded.frontMatter.updatedAt === undefined
          ? "publish"
          : "revise",
        decoded: fixture.decoded,
        fileContent: fixture.source,
        today: "2026-07-28",
      }),
      "AUTHOR_DATE_SOURCE",
    );
  }

  expectCode(
    () => planArticleDateEdit({
      action: "publish",
      decoded: null,
      fileContent: PUBLISH_SOURCE,
      today: "2026-07-28",
    }),
    "AUTHOR_DATE_SOURCE",
  );
  expectCode(
    () => planArticleDateEdit({
      action: "publish",
      decoded: decoded({...PUBLISHED_FRONT_MATTER, articleId: "not-a-uuid"}),
      fileContent: PUBLISH_SOURCE,
      today: "2026-07-28",
    }),
    "AUTHOR_DATE_SOURCE",
  );
  expectCode(
    () => planArticleDateEdit({
      action: "publish",
      decoded: decoded(PUBLISHED_FRONT_MATTER),
      fileContent: `${PUBLISH_SOURCE}\ud800`,
      today: "2026-07-28",
    }),
    "AUTHOR_DATE_SOURCE",
  );
});
