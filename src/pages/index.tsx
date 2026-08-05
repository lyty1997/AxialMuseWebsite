import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import {SeoMetadata} from "../components/SeoMetadata";
import styles from "./index.module.css";

export default function IndexPage() {
  return (
    <Layout>
      <SeoMetadata
        title="Axial Muse | 全栈技术 + AI 的生产力工具"
        description="Axial Muse 以全栈技术与 AI 构建好用的工具，分享公开项目、技术取舍与工程复盘。"
        socialDescription="Axial Muse 以全栈技术与 AI 构建好用的工具，分享公开项目、技术取舍与工程复盘。"
        canonicalPath="/"
        type="website"
      />
      <main className={styles.page}>
        <header className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>AXIAL MUSE · PROJECT LINE</p>
            <h1>用全栈技术 + AI，让所有人用上好用的工具。</h1>
            <p className={styles.lede}>Axial Muse 的愿景，是把专业能力转化为真正好用的工具，让生产力不再是少数人的特权。</p>
            <p className={styles.stage}>当前从公开项目与工程复盘开始，持续验证每一个产品方向，在边界明确、能力真实可用后再提供服务入口。</p>
          </div>
          <aside className={styles.brandStory} aria-label="Axial Muse 品牌含义">
            <div className={styles.axisMark} aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p className={styles.storyLabel}>WHY AXIAL MUSE</p>
            <dl>
              <div>
                <dt>Axial · 轴心</dt>
                <dd>来自轴心时代涌现的大师，代表经得起时间检验的思想与方法。</dd>
              </div>
              <div>
                <dt>Muse · 穆斯</dt>
                <dd>让灵感落地，让技术成为改善日常生活的真实力量。</dd>
              </div>
              <div>
                <dt>Technology · 工具</dt>
                <dd>把专业能力沉淀为人人可用、持续进化的工具与服务。</dd>
              </div>
            </dl>
          </aside>
        </header>

        <section className={styles.about} aria-labelledby="about">
          <div className={styles.aboutCopy}>
            <p className={styles.aboutEyebrow}>ABOUT</p>
            <Heading as="h2" id="about">关于我</Heading>
            <p>我是一个全栈工程师，覆盖人工智能、系统架构、底层驱动、硬件设计、机械工程、制造工艺，曾在达摩院做系统开发。</p>
            <p>关注 AI 工程、前沿科技，正在进行多个个人项目开发。本站分享公开项目、技术取舍与复盘，不公开凭证或私有仓库。</p>
          </div>
          <div className={styles.contacts} aria-label="联系方式">
            <a
              className={styles.contactLink}
              href="mailto:lyzimin@outlook.com"
              aria-label="发送邮件到 lyzimin@outlook.com"
            >
              <span className={styles.contactIcon} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m4 7 8 6 8-6" />
                </svg>
              </span>
              <span>
                <small>EMAIL</small>
                <strong>lyzimin@outlook.com</strong>
              </span>
              <span className={styles.contactArrow} aria-hidden="true">↗</span>
            </a>
            <a
              className={styles.contactLink}
              href="https://github.com/lyty1997"
              aria-label="打开 lyty1997 的 GitHub 主页"
            >
              <span className={styles.contactIcon} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M9 19c-4.5 1.4-4.5-2.5-6-3m12 6v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6A4.7 4.7 0 0 0 18.7 7 4.3 4.3 0 0 0 18.6 3S17.5 2.7 15 4.3a13.5 13.5 0 0 0-6 0C6.5 2.7 5.4 3 5.4 3A4.3 4.3 0 0 0 5.3 7 4.7 4.7 0 0 0 4 10.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V22" />
                </svg>
              </span>
              <span>
                <small>GITHUB</small>
                <strong>github.com/lyty1997</strong>
              </span>
              <span className={styles.contactArrow} aria-hidden="true">↗</span>
            </a>
          </div>
        </section>
      </main>
    </Layout>
  );
}
