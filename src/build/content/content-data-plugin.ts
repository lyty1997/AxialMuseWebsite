import type {PluginModule} from "@docusaurus/types";
import {randomBytes} from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import {failContentBuild} from "./errors.js";
import {
  ARTICLE_DATE_INDEX_RELATIVE_PATH,
  assertProductionArtifact,
  canonicalArticleDateIndex,
} from "./production-artifact-check.js";
import {assertLoadedValidatedContent} from "./loader.js";
import {assertContentBuildSession} from "./session.js";
import type {ContentBuildSession} from "./session.js";

const PLUGIN_NAME = "axial-muse-content-data";
const CHECK_COMMAND = "axial-muse:check-production";

function privateDateIndexTarget(generatedFilesDirectory: string): string {
  if (
    !isAbsolute(generatedFilesDirectory)
    || resolve(generatedFilesDirectory) !== generatedFilesDirectory
  ) {
    failContentBuild("CONTENT_PLUGIN_DATE_INDEX", "generated files 根必须是规范绝对路径。", {
      sourcePath: ARTICLE_DATE_INDEX_RELATIVE_PATH,
    });
  }
  try {
    const rootMetadata = lstatSync(generatedFilesDirectory);
    if (
      rootMetadata.isSymbolicLink()
      || !rootMetadata.isDirectory()
      || realpathSync(generatedFilesDirectory) !== generatedFilesDirectory
    ) {
      throw new TypeError("generated files root is not a real directory");
    }
    const target = resolve(generatedFilesDirectory, ARTICLE_DATE_INDEX_RELATIVE_PATH);
    const relation = relative(generatedFilesDirectory, target);
    if (relation !== ARTICLE_DATE_INDEX_RELATIVE_PATH) {
      throw new TypeError("private index escapes generated files root");
    }
    const targetDirectory = dirname(target);
    mkdirSync(targetDirectory, {recursive: true, mode: 0o700});
    const directoryMetadata = lstatSync(targetDirectory);
    if (
      directoryMetadata.isSymbolicLink()
      || !directoryMetadata.isDirectory()
      || realpathSync(targetDirectory) !== targetDirectory
    ) {
      throw new TypeError("private index directory is not a real directory");
    }
    return target;
  } catch (error) {
    failContentBuild("CONTENT_PLUGIN_DATE_INDEX", "私有日期索引目录无法安全准备。", {
      cause: error,
      sourcePath: ARTICLE_DATE_INDEX_RELATIVE_PATH,
    });
  }
}

function writePrivateDateIndex(
  generatedFilesDirectory: string,
  session: ContentBuildSession,
): void {
  const target = privateDateIndexTarget(generatedFilesDirectory);
  const targetDirectory = dirname(target);
  const temporary = resolve(
    targetDirectory,
    `.article-date-index-${process.pid}-${randomBytes(16).toString("hex")}.tmp`,
  );
  let renamed = false;
  let operationError: unknown;
  try {
    writeFileSync(temporary, canonicalArticleDateIndex(session.content), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    if (realpathSync(targetDirectory) !== targetDirectory) {
      throw new TypeError("private index directory drifted before rename");
    }
    renameSync(temporary, target);
    renamed = true;
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  if (!renamed) {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error;
    }
  }
  if (operationError !== undefined || cleanupError !== undefined) {
    const cause = operationError !== undefined && cleanupError !== undefined
      ? new AggregateError([operationError, cleanupError])
      : operationError ?? cleanupError;
    failContentBuild("CONTENT_PLUGIN_DATE_INDEX", "私有日期索引无法原子写入。", {
      cause,
      sourcePath: ARTICLE_DATE_INDEX_RELATIVE_PATH,
    });
  }
}

function createContentDataPluginModule(
  session: ContentBuildSession,
): PluginModule<undefined> {
  return function axialMuseContentDataPlugin(context) {
    return {
      name: PLUGIN_NAME,
      contentLoaded({actions}) {
        actions.setGlobalData({
          projectNavigation: session.content.projectNavigation,
          writingNavigation: session.content.writingNavigation,
        });
      },
      postBuild({outDir}) {
        if (session.phase !== "build" || resolve(outDir) !== session.outputDirectory) {
          failContentBuild("CONTENT_PLUGIN_POST_BUILD", "服务端 postBuild 只允许写入当前 build 候选。", {
            sourcePath: "build",
          });
        }
        session.publishStaticAssets(outDir);
        writePrivateDateIndex(context.generatedFilesDir, session);
        session.writeBuildSeal();
      },
      extendCli(cli) {
        cli
          .command(CHECK_COMMAND)
          .description("串行验收 Axial Muse production 候选制品")
          .action(async () => {
            if (
              (
                session.phase !== "check"
                && session.phase !== "verify"
                && session.phase !== "release"
              )
              || session.content.mode !== "production"
            ) {
              failContentBuild("CONTENT_PLUGIN_CHECK_PHASE", "production checker 只接受受控 check 阶段。", {
                sourcePath: "build",
              });
            }
            try {
              if (session.phase === "release") session.writeBuildSeal();
              session.assertBuildSeal();
              assertProductionArtifact(
                session.content,
                session.staticPlan,
                session.outputDirectory,
                context.generatedFilesDir,
              );
              session.assertBuildSeal();
            } finally {
              session.staticPlan.dispose();
            }
          });
      },
    };
  };
}

export function createContentDataPlugin(
  session: ContentBuildSession,
): PluginModule<undefined> {
  assertContentBuildSession(session);
  assertLoadedValidatedContent(session.content);
  return createContentDataPluginModule(session);
}

export function createContentDataPluginForTest(
  session: ContentBuildSession,
): PluginModule<undefined> {
  assertLoadedValidatedContent(session.content);
  return createContentDataPluginModule(session);
}
