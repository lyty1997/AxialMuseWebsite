import type {ReactNode} from "react";
import OriginalDocItemContent from "@theme-original/DocItem/Content";
import {ContentMeta} from "../../../components/ContentMeta";

export interface DocItemContentProps {
  readonly children: ReactNode;
}

export default function DocItemContent({children}: DocItemContentProps) {
  return (
    <OriginalDocItemContent>
      <ContentMeta />
      {children}
    </OriginalDocItemContent>
  );
}
