import type {ReactNode} from "react";
import BackToTopButton from "@theme/BackToTopButton";
import {ContentDirectory} from "../../../components/ContentDirectory";
import styles from "./styles.module.css";

export interface DocRootLayoutProps {
  readonly children: ReactNode;
}

export default function DocRootLayout({children}: DocRootLayoutProps) {
  return (
    <div className={styles.docsWrapper}>
      <BackToTopButton />
      <div className={styles.docRoot}>
        <aside className={`theme-doc-sidebar-container ${styles.desktopDirectory}`}>
          <ContentDirectory variant="desktop" />
        </aside>
        <main className={styles.docMain}>
          <div className={styles.docItemWrapper}>
            <ContentDirectory variant="collapsible" />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
