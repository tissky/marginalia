import { useRef } from "react";

import { MarkdownView } from "@/components/MarkdownView";
import {
  LocatorBanner,
  TruncatedBanner,
  ViewerError,
  ViewerLoading,
  type JumpProps,
  useLineRatioJump,
  usePreviewText,
  useQuoteJump,
} from "./ViewerShared";
export function ExtractedMarkdownView({ entryId, quote, lineRange, onScrolled }:
  { entryId: string } & JumpProps,
) {
  const { text, err, truncated } = usePreviewText(entryId);
  const containerRef = useRef<HTMLDivElement>(null);
  const quoteState = useQuoteJump(containerRef, text, quote, onScrolled);
  const { flashKey: lineFlash } = useLineRatioJump(
    containerRef, text, quote ? null : lineRange, onScrolled,
  );
  if (err) return <ViewerError msg={err} />;
  if (text === null) return <ViewerLoading />;
  return (
    <div className="h-full overflow-auto px-6 py-4" ref={containerRef}>
      <div className="mx-auto max-w-3xl">
        {truncated && <TruncatedBanner />}
        {quoteState.banner}
        {quoteState.banner == null && lineFlash != null && lineRange && (
          <LocatorBanner kind="line" range={lineRange} />
        )}
        <MarkdownView content={text} />
      </div>
    </div>
  );
}
