import Layout from "@theme/Layout";
import {SeoMetadata} from "../../components/SeoMetadata";
import {WritingList} from "../../components/WritingList";
import styles from "./index.module.css";

export default function WritingPage() {
  return (
    <Layout>
      <SeoMetadata
        title="踩过的坑 | Axial Muse"
        description="浏览 Axial Muse 的技术分享，查看来自真实项目的工程问题、实现取舍与复盘记录。"
        socialDescription="浏览 Axial Muse 的技术分享，查看来自真实项目的工程问题、实现取舍与复盘记录。"
        canonicalPath="/writing/"
        type="website"
      />
      <main className={styles.page}>
        <header className={styles.header}>
          <p>LESSONS LEARNED</p>
          <h1>踩过的坑</h1>
          <span>不回避失败与弯路，沉淀来自真实项目的工程判断。</span>
        </header>
        <WritingList groupHeadingLevel="h2" />
      </main>
    </Layout>
  );
}
