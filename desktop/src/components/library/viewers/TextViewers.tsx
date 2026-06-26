import { useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus, prism } from "react-syntax-highlighter/dist/esm/styles/prism";

import { MarkdownView } from "@/components/MarkdownView";
import { useTheme } from "@/lib/theme";
import {
  LocatorBanner,
  TruncatedBanner,
  ViewerError,
  ViewerLoading,
  type JumpProps,
  useLineRatioJump,
  useQuoteJump,
  useTextResource,
} from "./ViewerShared";
export function MdView({ url, quote, lineRange, onScrolled }:
  { url: string } & JumpProps,
) {
  const { text, err } = useTextResource(url);
  const containerRef = useRef<HTMLDivElement>(null);
  const quoteState = useQuoteJump(containerRef, text, quote, onScrolled);
  // Quote takes precedence; lineRange only fires when no quote.
  const { flashKey: lineFlash } = useLineRatioJump(
    containerRef, text, quote ? null : lineRange, onScrolled,
  );
  if (err) return <ViewerError msg={err} />;
  if (text === null) return <ViewerLoading />;
  return (
    <div className="h-full overflow-auto px-6 py-4" ref={containerRef}>
      <div className="mx-auto max-w-3xl">
        {quoteState.banner}
        {quoteState.banner == null && lineFlash != null && lineRange && (
          <LocatorBanner kind="line" range={lineRange} />
        )}
        <MarkdownView content={text} />
      </div>
    </div>
  );
}


export function TextView({ url, quote, lineRange, onScrolled }:
  { url: string } & JumpProps,
) {
  const { text, err, truncated } = useTextResource(url);
  if (err) return <ViewerError msg={err} />;
  if (text === null) return <ViewerLoading />;
  return (
    <PlainTextLines
      text={text}
      quote={quote}
      lineRange={lineRange}
      truncated={truncated}
      onScrolled={onScrolled}
    />
  );
}

export function CodeView({ url, lang, quote, lineRange, onScrolled }:
  { url: string; lang: string } & JumpProps,
) {
  const { text, err, truncated } = useTextResource(url);
  const { effective } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [lineFlash, setLineFlash] = useState<number | null>(null);
  const quoteState = useQuoteJump(containerRef, text, quote, onScrolled);

  useEffect(() => {
    if (quote) return;  // quote path owns the highlight
    if (!text || !lineRange) return;
    const root = containerRef.current;
    if (!root) return;
    const lineEls = root.querySelectorAll<HTMLElement>(".react-syntax-highlighter-line-number");
    const target = lineEls[lineRange.start - 1]?.parentElement;
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      setLineFlash(Date.now());
      onScrolled?.();
      const t = window.setTimeout(() => setLineFlash(null), 1600);
      return () => window.clearTimeout(t);
    }
  }, [text, lineRange, quote, onScrolled]);

  if (err) return <ViewerError msg={err} />;
  if (text === null) return <ViewerLoading />;
  return (
    <div className="h-full overflow-auto" ref={containerRef}>
      {truncated && <TruncatedBanner />}
      {quoteState.banner}
      {quoteState.banner == null && lineFlash != null && lineRange && (
        <LocatorBanner kind="line" range={lineRange} />
      )}
      <SyntaxHighlighter
        language={lang}
        style={effective === "dark" ? vscDarkPlus : prism}
        customStyle={{ margin: 0, padding: "12px 16px", fontSize: 12 }}
        showLineNumbers
        wrapLongLines={false}
      >
        {text}
      </SyntaxHighlighter>
    </div>
  );
}

function PlainTextLines({
  text, quote, lineRange, truncated, onScrolled,
}: {
  text: string;
  quote: string | null;
  lineRange: { start: number; end: number } | null;
  truncated: boolean;
  onScrolled?: () => void;
}) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const containerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const [lineFlash, setLineFlash] = useState<number | null>(null);
  const quoteState = useQuoteJump(containerRef, text, quote, onScrolled);

  useEffect(() => {
    if (quote) return;
    if (!lineRange || !targetRef.current) return;
    targetRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    setLineFlash(Date.now());
    onScrolled?.();
    const t = window.setTimeout(() => setLineFlash(null), 1600);
    return () => window.clearTimeout(t);
  }, [lineRange, quote, onScrolled]);

  return (
    <div className="h-full overflow-auto" ref={containerRef}>
      {truncated && <TruncatedBanner />}
      {quoteState.banner}
      {quoteState.banner == null && lineFlash != null && lineRange && (
        <LocatorBanner kind="line" range={lineRange} />
      )}
      <pre className="whitespace-pre-wrap break-all px-4 py-3 font-mono text-xs">
        {lines.map((ln, i) => {
          const lineNo = i + 1;
          const inRange =
            !quote && lineRange && lineNo >= lineRange.start && lineNo <= lineRange.end;
          const isStart = !quote && lineRange && lineNo === lineRange.start;
          return (
            <div
              key={i}
              ref={isStart ? targetRef : undefined}
              className={
                inRange && lineFlash != null
                  ? "-mx-1 rounded bg-accent/15 px-1 transition-colors duration-1000"
                  : undefined
              }
            >
              {ln || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
