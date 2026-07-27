import Layout from "@theme/Layout";
import {SeoMetadata} from "../../components/SeoMetadata";
import {WritingList} from "../../components/WritingList";
import styles from "./index.module.css";

export default function WritingPage() {
  return (
    <Layout>
      <SeoMetadata
        title="技术分享 | Axial Muse"
        description="浏览 Axial Muse 的技术分享，查看来自真实项目的工程问题、实现取舍与复盘记录。"
        socialDescription="浏览 Axial Muse 的技术分享，查看来自真实项目的工程问题、实现取舍与复盘记录。"
        canonicalPath="/writing/"
        type="website"
      />
      <main className={styles.page}>
        <header className={styles.header}>
          <h1>技术分享</h1>
        </header>
        <WritingList groupHeadingLevel="h2" />
      </main>
    </Layout>
  );
}
