import Layout from "@theme/Layout";
import {ProjectList} from "../../components/ProjectList";
import {SeoMetadata} from "../../components/SeoMetadata";

export default function ProjectsPage() {
  return (
    <Layout>
      <SeoMetadata
        title="项目 | Axial Muse"
        description="浏览 Axial Muse 中已完成公开审核的个人项目，查看问题、实现、技术取舍与源码资料。"
        socialDescription="浏览 Axial Muse 中已完成公开审核的个人项目，查看问题、实现、技术取舍与源码资料。"
        canonicalPath="/projects/"
        type="website"
      />
      <main>
        <h1>项目</h1>
        <ProjectList headingLevel="h2" />
      </main>
    </Layout>
  );
}
