import Link from "@docusaurus/Link";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import {ProjectList} from "../components/ProjectList";
import {SeoMetadata} from "../components/SeoMetadata";
import {WritingList} from "../components/WritingList";

export default function IndexPage() {
  return (
    <Layout>
      <SeoMetadata
        title="Axial Muse | 个人项目与技术分享"
        description="Axial Muse 记录个人项目的设计、实现、技术取舍与复盘，公开可核验的源码与工程资料。"
        socialDescription="Axial Muse 记录个人项目的设计、实现、技术取舍与复盘，公开可核验的源码与工程资料。"
        canonicalPath="/"
        type="website"
      />
      <main>
        <header>
          <h1>Axial Muse</h1>
          <p>围绕个人项目，记录设计、实现、技术取舍与复盘。</p>
          <p>首版先公开可核验的项目资料和工程记录。产品服务会在边界明确并真实可用后再提供入口。</p>
          <Link to="/projects/">浏览项目</Link>
        </header>

        <section aria-labelledby="projects-heading">
          <h2 id="projects-heading">项目</h2>
          <ProjectList headingLevel="h3" />
        </section>

        <section aria-labelledby="writing-heading">
          <h2 id="writing-heading">技术分享</h2>
          <WritingList groupHeadingLevel="h3" />
        </section>

        <section aria-labelledby="roadmap">
          <Heading as="h2" id="roadmap">路线</Heading>
          <ol>
            <li>当前：建立可信主站</li>
            <li>下一步：形成技术分享</li>
            <li>探索：产品服务</li>
          </ol>
        </section>

        <section aria-labelledby="about">
          <Heading as="h2" id="about">关于</Heading>
          <p>我关注 AI 工程、知识工作流、开发规范和个人产品构建。本站公开项目、技术取舍与复盘，不公开私人联系方式、凭证或私有仓库。</p>
        </section>
      </main>
    </Layout>
  );
}
