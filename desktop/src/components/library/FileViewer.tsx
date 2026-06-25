/** Renders the body of a file entry. Tier 1 (browser-native) + OOXML:
 *
 *    PDF   → <iframe> the download URL; browser's PDF reader takes over
 *    image → <img>
 *    md    → react-markdown
 *    text  → react-syntax-highlighter (or <pre> for very large files)
 *    docx/xlsx/xlsm/pptx/pptm → @silurus/ooxml renders Office Open XML to canvas
 *    other → "Preview not available — open in default app" + download link
 *
 *  We rely on the entry's display_name extension and metadata.mime_type
 *  to decide. Both are best-effort — Marginalia's mime detection is
 *  loose, so we fall back to extension when in doubt.
 *
 *  Deep-link locators (`{kind: "quote"|"line"|"page", value}`) come from
 *  chat citations:
 *    quote → walk the rendered DOM, surround the matching text with a
 *            <mark>, scroll it into view, then unwrap after a flash
 *    line  → text/code views scroll to the target line range; markdown
 *            uses ratio approximation (legacy; stable_context no longer
 *            asks the LLM to write `lines=`, but historical sessions and
 *            manual deep-links still resolve)
 *    page  → PDF iframe receives `#page=N`
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import {
  FileText,
  Download,
  AlertCircle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus, prism } from "react-syntax-highlighter/dist/esm/styles/prism";

import { fileEntries } from "@/api/client";
import { MarkdownView } from "@/components/MarkdownView";
import type { FileMetadata } from "@/types/api";
import { useTheme } from "@/lib/theme";
import { useI18n } from "@/lib/i18n";

export interface ViewerLocator {
  kind: "quote" | "line" | "page";
  value: string;
}

interface Props {
  entryId: string;
  meta: FileMetadata | null;
  locator?: ViewerLocator | null;
  onLocatorConsumed?: () => void;
}

type Kind = "pdf" | "image" | "md" | "text" | "code" | "docx" | "xlsx" | "pptx" | "binary";
type SingleCanvasOoxmlKind = "xlsx" | "pptx";

const TEXT_EXT = new Set([
  "txt", "log", "csv", "tsv", "ini", "conf", "env", "sql", "rst",
]);
const CODE_EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  html: "html", css: "css", scss: "scss",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
  md: "markdown",
};

function classifyByName(name: string): Kind {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "pptx" || ext === "pptm") return "pptx";
  if (CODE_EXT_TO_LANG[ext]) return "code";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

function parseLineRange(value: string): { start: number; end: number } | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1) return null;
  return { start, end: Math.max(start, end) };
}

export function FileViewer({ entryId, meta, locator, onLocatorConsumed }: Props) {
  const { t } = useI18n();
  const name = meta?.display_name || "";
  const kind = useMemo<Kind>(() => classifyByName(name), [name]);
  const contentUrl = fileEntries.contentUrl(entryId);
  const downloadUrl = fileEntries.downloadUrl(entryId);

  const lineLoc = locator?.kind === "line" ? parseLineRange(locator.value) : null;
  const pageLoc = locator?.kind === "page" ? parseInt(locator.value, 10) : null;
  const quoteLoc = locator?.kind === "quote" ? locator.value : null;
  // PDF reads its locator straight from the URL fragment, so consume it
  // immediately. Text-family viewers consume it after their scroll runs.
  useEffect(() => {
    if (kind === "pdf" && locator && onLocatorConsumed) onLocatorConsumed();
  }, [kind, locator, onLocatorConsumed]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-subtle px-4 py-2 text-sm">
        <FileText size={14} className="text-fg-muted" />
        <span className="flex-1 truncate font-medium">{name || t.common.unset}</span>
        <a href={downloadUrl} download className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-bg-muted">
          <Download size={12} /> {t.library.download}
        </a>
      </header>
      <div className="flex-1 overflow-hidden">
        {kind === "pdf" && (
          <PdfView
            url={contentUrl}
            page={Number.isFinite(pageLoc as number) ? (pageLoc as number) : null}
          />
        )}
        {kind === "image" && <ImageView url={contentUrl} />}
        {kind === "md" && (
          <MdView
            url={contentUrl}
            quote={quoteLoc}
            lineRange={lineLoc}
            onScrolled={onLocatorConsumed}
          />
        )}
        {kind === "text" && (
          <TextView
            url={contentUrl}
            quote={quoteLoc}
            lineRange={lineLoc}
            onScrolled={onLocatorConsumed}
          />
        )}
        {kind === "code" && (
          <CodeView
            url={contentUrl}
            lang={CODE_EXT_TO_LANG[(name.split(".").pop() || "").toLowerCase()] || "text"}
            quote={quoteLoc}
            lineRange={lineLoc}
            onScrolled={onLocatorConsumed}
          />
        )}
        {kind === "docx" && (
          <DocxScrollView
            url={contentUrl}
            quote={quoteLoc}
            onScrolled={onLocatorConsumed}
          />
        )}
        {kind === "xlsx" && (
          <OoxmlView
            url={contentUrl}
            format="xlsx"
            quote={quoteLoc}
            onScrolled={onLocatorConsumed}
          />
        )}
        {kind === "pptx" && (
          <OoxmlView
            url={contentUrl}
            format="pptx"
            quote={quoteLoc}
            onScrolled={onLocatorConsumed}
          />
        )}
        {kind === "binary" && <BinaryView url={downloadUrl} name={name} />}
      </div>
    </div>
  );
}

function PdfView({ url, page }: { url: string; page: number | null }) {
  // The PDF Open Parameters spec lets us append `#page=N` to scroll the
  // browser viewer to a 1-indexed page. Works in Chrome, Firefox, and
  // Edge's built-in viewers — Safari historically ignores it but degrades
  // to "open at page 1", which is acceptable.
  //
  // Pin the page in a ref: FileViewer clears the locator immediately
  // after first commit, so on the next render `page` flips to null and
  // the iframe `src` would lose its `#page=N` fragment, reloading the
  // viewer back to page 1. Refresh the pin when `url` changes (different
  // file) or when a fresh non-null page arrives for the same file (the
  // user clicked a second citation into the same PDF).
  const pageRef = useRef<number | null>(page);
  const urlRef = useRef(url);
  if (urlRef.current !== url) {
    urlRef.current = url;
    pageRef.current = page;
  } else if (page != null) {
    pageRef.current = page;
  }
  const p = pageRef.current;
  const src = p ? `${url}#page=${p}` : url;
  return <iframe src={src} className="h-full w-full border-0" title="pdf" />;
}

function ImageView({ url }: { url: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const zoom = useViewportWheelZoom(scrollRef, pageRefs, {
    resetKey: url,
    applyZoom: (value) => applyVisualPageScale(pageRefs.current, value),
  });

  const refreshImageZoom = () => {
    const page = pageRefs.current[0];
    if (!page) return;
    refreshVisualPageBase(page);
    applyVisualPageScale(pageRefs.current, zoom.zoomRef.current);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-subtle">
      <div className="flex h-9 shrink-0 items-center justify-end border-b border-border bg-bg px-3 text-xs text-fg-muted">
        <span className="min-w-16 text-center tabular-nums">{Math.round(zoom.zoom * 100)}%</span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-full w-full items-center justify-center p-4">
          <div
            ref={(el) => { pageRefs.current[0] = el; }}
            className="inline-flex justify-center"
          >
            <div className="inline-block">
              <img
                src={url}
                className="block max-h-full max-w-full object-contain"
                alt=""
                onLoad={refreshImageZoom}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function useTextResource(url: string, maxBytes = 2_000_000) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setText(null); setErr(null); setTruncated(false);
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const buf = await r.arrayBuffer();
        const slice = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
        const t = decodeTextBytes(slice, r.headers.get("content-type") || "");
        if (!cancelled) {
          setText(t);
          setTruncated(buf.byteLength > maxBytes);
        }
      })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [url, maxBytes]);
  return { text, err, truncated };
}

function decodeTextBytes(buf: ArrayBuffer, contentType: string): string {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return stripLeadingBom(new TextDecoder("utf-8").decode(bytes.subarray(3)));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return stripLeadingBom(decodeWith("utf-16le", bytes.subarray(2)) ?? "");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return stripLeadingBom(decodeWith("utf-16be", bytes.subarray(2)) ?? "");
  }

  const charset = parseCharset(contentType);
  if (charset) {
    const decoded = decodeWith(charset, bytes);
    if (decoded != null) return stripLeadingBom(decoded);
  }

  const utf8 = decodeUtf8Strict(bytes);
  if (utf8 != null) return stripLeadingBom(utf8);

  const utf16 = decodeLikelyUtf16(bytes);
  if (utf16 != null) return stripLeadingBom(utf16);

  // Common for Chinese Markdown edited by Windows-era tools. Only tried
  // after strict UTF-8 fails, so normal UTF-8 content keeps the fast path.
  const gb18030 = decodeWith("gb18030", bytes);
  if (gb18030 != null) return stripLeadingBom(gb18030);

  return stripLeadingBom(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
}

function parseCharset(contentType: string): string | null {
  const m = /(?:^|;)\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
  if (!m) return null;
  const label = m[1].trim().toLowerCase();
  return label === "utf8" ? "utf-8" : label;
}

function decodeWith(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeUtf8Strict(bytes: Uint8Array): string | null {
  for (let trim = 0; trim <= 3 && trim < bytes.length; trim += 1) {
    try {
      const view = trim === 0 ? bytes : bytes.subarray(0, bytes.length - trim);
      return new TextDecoder("utf-8", { fatal: true }).decode(view);
    } catch {
      /* A truncated preview can cut a multi-byte char; trim and retry. */
    }
  }
  return null;
}

function decodeLikelyUtf16(bytes: Uint8Array): string | null {
  const sample = bytes.subarray(0, Math.min(bytes.length, 1024));
  if (sample.length < 8) return null;
  let evenNulls = 0;
  let oddNulls = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] !== 0) continue;
    if (i % 2 === 0) evenNulls += 1;
    else oddNulls += 1;
  }
  const pairs = Math.floor(sample.length / 2);
  if (oddNulls > pairs / 3) return decodeWith("utf-16le", bytes);
  if (evenNulls > pairs / 3) return decodeWith("utf-16be", bytes);
  return null;
}

function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

interface ViewportZoomAnchor {
  pageIndex: number;
  relX: number;
  relY: number;
  clientX: number;
  clientY: number;
}

const VIEWER_MIN_ZOOM = 0.45;
const VIEWER_MAX_ZOOM = 2.5;

function useViewportWheelZoom(
  rootRef: RefObject<HTMLDivElement>,
  pagesRef: MutableRefObject<(HTMLDivElement | null)[]>,
  opts: {
    resetKey: string;
    min?: number;
    max?: number;
    applyZoom?: (zoom: number) => void;
    onZoomSettled?: (zoom: number) => void;
  },
) {
  const min = opts.min ?? VIEWER_MIN_ZOOM;
  const max = opts.max ?? VIEWER_MAX_ZOOM;
  const applyZoomRef = useRef(opts.applyZoom);
  const onZoomSettledRef = useRef(opts.onZoomSettled);
  const zoomRef = useRef(1);
  const zoomLabelFrameRef = useRef<number | null>(null);
  const zoomLabelValueRef = useRef(1);
  const zoomSettledRef = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    applyZoomRef.current = opts.applyZoom;
    onZoomSettledRef.current = opts.onZoomSettled;
  });

  useEffect(() => {
    zoomRef.current = 1;
    zoomLabelValueRef.current = 1;
    setZoom(1);
    applyZoomRef.current?.(1);
    return () => {
      if (zoomLabelFrameRef.current != null) {
        window.cancelAnimationFrame(zoomLabelFrameRef.current);
        zoomLabelFrameRef.current = null;
      }
      if (zoomSettledRef.current != null) {
        window.clearTimeout(zoomSettledRef.current);
        zoomSettledRef.current = null;
      }
    };
  }, [opts.resetKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const prev = zoomRef.current;
      const deltaY = normalizedWheelDeltaY(event, root);
      const factor = clamp(Math.exp(-deltaY * 0.001), 0.75, 1.333);
      const next = clamp(prev * factor, min, max);
      if (Math.abs(next - prev) < 0.001) return;
      const anchor = makeViewportZoomAnchor(
        pagesRef.current,
        event.clientX,
        event.clientY,
      );
      zoomRef.current = next;
      const applyZoom = applyZoomRef.current ?? ((value: number) => {
        applyVisualPageScale(pagesRef.current, value);
      });
      applyZoom(next);
      if (anchor) {
        const page = pagesRef.current[anchor.pageIndex];
        if (page) preserveViewportZoomAnchor(root, page, anchor);
      }
      scheduleViewportZoomLabel(zoomLabelFrameRef, zoomLabelValueRef, setZoom, next);
      if (zoomSettledRef.current != null) {
        window.clearTimeout(zoomSettledRef.current);
      }
      zoomSettledRef.current = window.setTimeout(() => {
        zoomSettledRef.current = null;
        onZoomSettledRef.current?.(zoomRef.current);
      }, 220);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [max, min, pagesRef, rootRef]);

  return { zoom, zoomRef };
}

interface JumpProps {
  quote: string | null;
  lineRange: { start: number; end: number } | null;
  onScrolled?: () => void;
}

function MdView({ url, quote, lineRange, onScrolled }:
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

function TextView({ url, quote, lineRange, onScrolled }:
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

function CodeView({ url, lang, quote, lineRange, onScrolled }:
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
              {ln || "​"}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

// Markdown reflows source lines, so we can't pin to "line 42" with
// per-line wrappers like the plain-text viewer does. Approximate via
// scrollHeight ratio. Kept for legacy `?line=` deep-links; quote jump
// is preferred (and stable_context no longer asks the LLM for line=).
function useLineRatioJump(
  ref: RefObject<HTMLDivElement>,
  text: string | null,
  lineRange: { start: number; end: number } | null,
  onScrolled?: () => void,
) {
  const [flashKey, setFlashKey] = useState<number | null>(null);
  useEffect(() => {
    if (!text || !lineRange || !ref.current) return;
    const total = text.split("\n").length || 1;
    const ratio = Math.max(0, (lineRange.start - 1) / total);
    const handle = window.requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.scrollTop = ratio * el.scrollHeight;
      setFlashKey(Date.now());
      onScrolled?.();
    });
    const t = window.setTimeout(() => setFlashKey(null), 1600);
    return () => {
      window.cancelAnimationFrame(handle);
      window.clearTimeout(t);
    };
  }, [text, lineRange, onScrolled, ref]);
  return { flashKey };
}

// Quote-based jump: walk the rendered text DOM, surround the first text
// node containing the quote with a <mark>, scroll it into view, then
// unwrap after a 1.6 s flash. First-version heuristic — only matches
// against a single text node, so quotes that get split by inline
// formatting (e.g. <strong> mid-sentence in DOCX) won't match.
// `content` is the source string we render — used as the dep so the
// effect re-runs once the DOM has the new content.
function useQuoteJump(
  ref: RefObject<HTMLElement>,
  content: string | null,
  quote: string | null,
  onScrolled?: () => void,
) {
  const [hit, setHit] = useState<"found" | "missing" | null>(null);
  useEffect(() => {
    if (!quote || !content || !ref.current) {
      setHit(null);
      return;
    }
    const root = ref.current;
    let marks: HTMLElement[] = [];
    let cleanup: number | null = null;
    let handle2: number | null = null;
    // rAF to wait for layout to settle (OOXML text overlays, syntax
    // highlighting, KaTeX). Two frames is enough for prism + react-markdown.
    const handle1 = window.requestAnimationFrame(() => {
      handle2 = window.requestAnimationFrame(() => {
        marks = highlightQuoteInDom(root, quote);
        if (marks.length > 0) {
          marks[0].scrollIntoView({ block: "center", behavior: "smooth" });
          setHit("found");
          cleanup = window.setTimeout(() => {
            marks.forEach(unwrapMark);
          }, 1600);
        } else {
          setHit("missing");
        }
        onScrolled?.();
      });
    });
    return () => {
      window.cancelAnimationFrame(handle1);
      if (handle2 != null) window.cancelAnimationFrame(handle2);
      if (cleanup != null) window.clearTimeout(cleanup);
      marks.forEach(unwrapMark);
    };
  }, [content, quote, onScrolled, ref]);
  const banner = quote && hit === "found"
    ? <LocatorBanner kind="quote" quote={quote} />
    : quote && hit === "missing"
      ? <LocatorBanner kind="quote-missing" quote={quote} />
      : null;
  return { banner };
}

function highlightQuoteInDom(root: HTMLElement, quote: string): HTMLElement[] {
  const exact = highlightExactQuoteInDom(root, quote);
  if (exact.length > 0) return exact;
  return highlightNormalizedQuoteInDom(root, quote);
}

function highlightExactQuoteInDom(root: HTMLElement, quote: string): HTMLElement[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const tn = node as Text;
    const text = tn.data;
    const idx = text.indexOf(quote);
    if (idx === -1) continue;
    const range = document.createRange();
    range.setStart(tn, idx);
    range.setEnd(tn, idx + quote.length);
    const mark = document.createElement("mark");
    mark.className = "rounded bg-accent/30 px-0.5";
    range.surroundContents(mark);
    return [mark];
  }
  return [];
}

interface SearchChar {
  node: Text;
  offset: number;
}

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

function highlightNormalizedQuoteInDom(root: HTMLElement, quote: string): HTMLElement[] {
  const needle = normalizeSearchText(quote);
  if (needle.length < 3) return [];
  const index = buildDomSearchIndex(root);
  const start = index.text.indexOf(needle);
  if (start === -1) return [];
  const end = start + needle.length;
  const segments = segmentsForMatch(index.map.slice(start, end));
  const marks: HTMLElement[] = [];
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const mark = wrapTextSegment(segments[i]);
    if (mark) marks.unshift(mark);
  }
  return marks;
}

function buildDomSearchIndex(root: HTMLElement): { text: string; map: SearchChar[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  const map: SearchChar[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const tn = node as Text;
    for (let i = 0; i < tn.data.length; i += 1) {
      const normalized = normalizeSearchChar(tn.data[i]);
      for (const ch of normalized) {
        text += ch;
        map.push({ node: tn, offset: i });
      }
    }
  }
  return { text, map };
}

function normalizeSearchText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    out += normalizeSearchChar(value[i]);
  }
  return out;
}

function normalizeSearchChar(value: string): string {
  let out = "";
  for (const ch of value.normalize("NFKC").toLowerCase()) {
    if (/[\p{L}\p{N}_]/u.test(ch)) out += ch;
  }
  return out;
}

function segmentsForMatch(chars: SearchChar[]): TextSegment[] {
  const segments: TextSegment[] = [];
  for (const ch of chars) {
    const last = segments[segments.length - 1];
    if (last && last.node === ch.node && ch.offset <= last.end) {
      last.end = Math.max(last.end, ch.offset + 1);
      continue;
    }
    segments.push({ node: ch.node, start: ch.offset, end: ch.offset + 1 });
  }
  return segments;
}

function wrapTextSegment(segment: TextSegment): HTMLElement | null {
  if (segment.start >= segment.end) return null;
  try {
    const range = document.createRange();
    range.setStart(segment.node, segment.start);
    range.setEnd(segment.node, segment.end);
    const mark = document.createElement("mark");
    mark.className = "rounded bg-accent/30 px-0.5";
    range.surroundContents(mark);
    return mark;
  } catch {
    return null;
  }
}

function unwrapMark(mark: HTMLElement | null) {
  if (!mark || !mark.parentNode) return;
  const parent = mark.parentNode;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  // Re-merge adjacent text nodes to keep the DOM tidy.
  parent.normalize?.();
}

function LocatorBanner(
  props:
    | { kind: "line"; range: { start: number; end: number } }
    | { kind: "quote"; quote: string }
    | { kind: "quote-missing"; quote: string },
) {
  const { t } = useI18n();
  if (props.kind === "line") {
    const span = props.range.start === props.range.end
      ? t.library.line(props.range.start)
      : t.library.lines(props.range.start, props.range.end);
    return (
      <div className="sticky top-0 z-10 border-b border-accent/30 bg-accent/10 px-3 py-1 text-[11px] font-mono text-accent">
        {t.library.jumpedLine(span)}
      </div>
    );
  }
  const head = props.quote.length > 30 ? props.quote.slice(0, 30) + "..." : props.quote;
  if (props.kind === "quote-missing") {
    return (
      <div className="sticky top-0 z-10 border-b border-warning/30 bg-warning/10 px-3 py-1 text-[11px] text-warning">
        {t.library.quoteMissing(head)}
      </div>
    );
  }
  return (
    <div className="sticky top-0 z-10 border-b border-accent/30 bg-accent/10 px-3 py-1 text-[11px] text-accent">
      {t.library.quoteJumped(head)}
    </div>
  );
}

type DocxDocumentInstance = import("@silurus/ooxml/docx").DocxDocument;
type PptxViewerInstance = import("@silurus/ooxml/pptx").PptxViewer;
type XlsxViewerInstance = import("@silurus/ooxml/xlsx").XlsxViewer;
type OoxmlViewerInstance =
  | PptxViewerInstance
  | XlsxViewerInstance;

interface DocxTextRunInfo {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  font: string;
}

const DOCX_BASE_WIDTH = 960;
const DOCX_MIN_ZOOM = 0.45;
const DOCX_MAX_ZOOM = 2.5;

function DocxScrollView({ url, quote, onScrolled }: {
  url: string;
  quote: string | null;
  onScrolled?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<DocxDocumentInstance | null>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rasterZoomRef = useRef(1);
  const [ready, setReady] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [renderRequestZoom, setRenderRequestZoom] = useState(1);
  const [renderKey, setRenderKey] = useState(0);
  const zoom = useViewportWheelZoom(scrollRef, pageRefs, {
    resetKey: `docx:${url}`,
    min: DOCX_MIN_ZOOM,
    max: DOCX_MAX_ZOOM,
    applyZoom: (value) => applyDocxPreviewScale(
      pageRefs.current,
      value / rasterZoomRef.current,
    ),
    onZoomSettled: setRenderRequestZoom,
  });
  const quoteState = useQuoteJump(
    scrollRef,
    ready && renderKey > 0 ? `docx:${url}:${renderKey}` : null,
    quote,
    onScrolled,
  );

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setRendering(false);
    setErr(null);
    setPageCount(0);
    setCurrentPage(0);
    setRenderRequestZoom(1);
    setRenderKey(0);
    rasterZoomRef.current = 1;
    pageRefs.current = [];
    docRef.current?.destroy();
    docRef.current = null;

    (async () => {
      try {
        const { DocxDocument } = await import("@silurus/ooxml/docx");
        const doc = await DocxDocument.load(url);
        if (cancelled) {
          doc.destroy();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.pageCount);
        setReady(true);
      } catch (error) {
        if (!cancelled) {
          setErr(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      cancelled = true;
      docRef.current?.destroy();
      docRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      setCurrentPage(nearestDocxPage(root, pageRefs.current));
    };
    const schedule = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, [pageCount]);

  useEffect(() => {
    if (!ready || pageCount <= 0) return;
    const doc = docRef.current;
    if (!doc) return;
    let cancelled = false;
    const handle = window.requestAnimationFrame(() => {
      setRendering(true);
      void (async () => {
        const root = scrollRef.current;
        const renderAnchor = root ? makeViewportCenterAnchor(root, pageRefs.current) : null;
        try {
          for (let i = 0; i < pageCount; i += 1) {
            if (cancelled) return;
            const pageEl = pageRefs.current[i];
            if (!pageEl) continue;
            await renderDocxPage(
              pageEl,
              doc,
              i,
              renderRequestZoom,
              zoom.zoomRef.current / renderRequestZoom,
            );
          }
          if (!cancelled) {
            rasterZoomRef.current = renderRequestZoom;
            applyDocxPreviewScale(pageRefs.current, zoom.zoomRef.current / renderRequestZoom);
            if (root && renderAnchor) {
              const page = pageRefs.current[renderAnchor.pageIndex];
              if (page) preserveViewportZoomAnchor(root, page, renderAnchor);
            }
            setRenderKey((n) => n + 1);
            setRendering(false);
          }
        } catch (error) {
          if (!cancelled) {
            setErr(error instanceof Error ? error.message : String(error));
            setRendering(false);
          }
        }
      })();
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(handle);
    };
  }, [ready, pageCount, renderRequestZoom]);

  const canPrev = ready && currentPage > 0;
  const canNext = ready && pageCount > 0 && currentPage < pageCount - 1;
  const label = pageCount > 0
    ? `Page ${currentPage + 1}/${pageCount} · ${Math.round(zoom.zoom * 100)}%`
    : `Page · ${Math.round(zoom.zoom * 100)}%`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-subtle">
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border bg-bg px-3 text-xs text-fg-muted">
        <button
          type="button"
          title="Previous page"
          disabled={!canPrev}
          onClick={() => scrollDocxPage(pageRefs.current, currentPage - 1)}
          className="rounded border border-border p-1 hover:bg-bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronUp size={14} />
        </button>
        <span className="min-w-36 text-center tabular-nums">{label}</span>
        <button
          type="button"
          title="Next page"
          disabled={!canNext}
          onClick={() => scrollDocxPage(pageRefs.current, currentPage + 1)}
          className="rounded border border-border p-1 hover:bg-bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        {quoteState.banner}
        <div className="flex min-h-full w-full flex-col items-center gap-4 p-4">
          {Array.from({ length: pageCount }, (_, i) => (
            <div
              key={i}
              ref={(el) => { pageRefs.current[i] = el; }}
              className="flex min-h-24 justify-center"
            />
          ))}
        </div>
        {(!ready || (rendering && renderKey === 0)) && !err && (
          <div className="absolute inset-0 z-20 bg-bg/70">
            <ViewerLoading />
          </div>
        )}
        {err && (
          <div className="absolute inset-0 z-20 bg-bg">
            <ViewerError msg={err} />
          </div>
        )}
      </div>
    </div>
  );
}

async function renderDocxPage(
  pageEl: HTMLDivElement,
  doc: DocxDocumentInstance,
  pageIndex: number,
  zoom: number,
  previewScale: number,
): Promise<void> {
  const wrapper = document.createElement("div");
  wrapper.className = "relative inline-block align-top bg-white shadow-sm";
  const canvas = document.createElement("canvas");
  canvas.className = "block bg-white";
  const textLayer = document.createElement("div");
  textLayer.style.cssText =
    "position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;pointer-events:none;user-select:text;-webkit-user-select:text;";
  wrapper.appendChild(canvas);
  wrapper.appendChild(textLayer);

  const runs: DocxTextRunInfo[] = [];
  const dpr = window.devicePixelRatio || 1;
  await doc.renderPage(canvas, pageIndex, {
    width: DOCX_BASE_WIDTH * zoom,
    dpr,
    onTextRun: (run: DocxTextRunInfo) => runs.push(run),
  });
  buildDocxTextLayer(textLayer, canvas, runs);
  const width = parseCssPixels(canvas.style.width) || canvas.width / dpr;
  const height = parseCssPixels(canvas.style.height) || canvas.height / dpr;
  pageEl.dataset.docxBaseWidth = String(width);
  pageEl.dataset.docxBaseHeight = String(height);
  pageEl.style.overflow = "visible";
  wrapper.style.transformOrigin = "top center";
  wrapper.style.willChange = "transform";
  setDocxPageScale(pageEl, wrapper, width, height, previewScale);
  pageEl.replaceChildren(wrapper);
}

function buildDocxTextLayer(
  textLayer: HTMLDivElement,
  canvas: HTMLCanvasElement,
  runs: DocxTextRunInfo[],
) {
  textLayer.replaceChildren();
  textLayer.style.width = canvas.style.width || `${canvas.width}px`;
  textLayer.style.height = canvas.style.height || `${canvas.height}px`;
  for (const run of runs) {
    const span = document.createElement("span");
    span.textContent = run.text;
    span.style.cssText =
      `position:absolute;left:${run.x}px;top:${run.y}px;` +
      `font:${run.font};line-height:${run.h}px;letter-spacing:0;` +
      "white-space:pre;color:transparent;cursor:text;pointer-events:all;";
    textLayer.appendChild(span);
  }
}

function applyDocxPreviewScale(
  pages: (HTMLDivElement | null)[],
  scale: number,
) {
  for (const page of pages) {
    if (!page) continue;
    const baseWidth = Number(page.dataset.docxBaseWidth || 0);
    const baseHeight = Number(page.dataset.docxBaseHeight || 0);
    const wrapper = page.firstElementChild as HTMLElement | null;
    if (!baseWidth || !baseHeight || !wrapper) continue;
    setDocxPageScale(page, wrapper, baseWidth, baseHeight, scale);
  }
}

function scheduleViewportZoomLabel(
  frameRef: MutableRefObject<number | null>,
  valueRef: MutableRefObject<number>,
  setZoom: (value: number) => void,
  zoom: number,
) {
  valueRef.current = zoom;
  if (frameRef.current != null) return;
  frameRef.current = window.requestAnimationFrame(() => {
    frameRef.current = null;
    setZoom(valueRef.current);
  });
}

function setDocxPageScale(
  page: HTMLDivElement,
  wrapper: HTMLElement,
  baseWidth: number,
  baseHeight: number,
  scale: number,
) {
  const safeScale = clamp(scale, DOCX_MIN_ZOOM / DOCX_MAX_ZOOM, DOCX_MAX_ZOOM / DOCX_MIN_ZOOM);
  page.style.width = `${baseWidth * safeScale}px`;
  page.style.height = `${baseHeight * safeScale}px`;
  wrapper.style.transformOrigin = "top center";
  wrapper.style.transform = Math.abs(safeScale - 1) < 0.001
    ? ""
    : `scale(${safeScale})`;
}

function refreshVisualPageBase(page: HTMLDivElement): boolean {
  const wrapper = page.firstElementChild as HTMLElement | null;
  if (!wrapper) return false;
  const rect = wrapper.getBoundingClientRect();
  const transform = wrapper.style.transform;
  if (transform) wrapper.style.transform = "";
  const width = wrapper.offsetWidth || rect.width;
  const height = wrapper.offsetHeight || rect.height;
  wrapper.style.transform = transform;
  if (!width || !height) return false;
  page.dataset.visualBaseWidth = String(width);
  page.dataset.visualBaseHeight = String(height);
  page.style.overflow = "visible";
  wrapper.style.transformOrigin = "top center";
  wrapper.style.willChange = "transform";
  return true;
}

function applyVisualPageScale(
  pages: (HTMLDivElement | null)[],
  zoom: number,
) {
  const safeZoom = clamp(zoom, VIEWER_MIN_ZOOM, VIEWER_MAX_ZOOM);
  for (const page of pages) {
    if (!page) continue;
    const wrapper = page.firstElementChild as HTMLElement | null;
    if (!wrapper) continue;
    let baseWidth = Number(page.dataset.visualBaseWidth || 0);
    let baseHeight = Number(page.dataset.visualBaseHeight || 0);
    if ((!baseWidth || !baseHeight) && refreshVisualPageBase(page)) {
      baseWidth = Number(page.dataset.visualBaseWidth || 0);
      baseHeight = Number(page.dataset.visualBaseHeight || 0);
    }
    if (!baseWidth || !baseHeight) continue;
    page.style.width = `${baseWidth * safeZoom}px`;
    page.style.height = `${baseHeight * safeZoom}px`;
    wrapper.style.transformOrigin = "top center";
    wrapper.style.transform = Math.abs(safeZoom - 1) < 0.001
      ? ""
      : `scale(${safeZoom})`;
  }
}

function parseCssPixels(value: string): number {
  const match = /^([\d.]+)px$/.exec(value.trim());
  return match ? Number(match[1]) : 0;
}

function normalizedWheelDeltaY(event: WheelEvent, root: HTMLElement): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * root.clientHeight;
  return event.deltaY;
}

function makeViewportZoomAnchor(
  pages: (HTMLDivElement | null)[],
  clientX: number,
  clientY: number,
): ViewportZoomAnchor | null {
  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestRect: DOMRect | null = null;
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (!page) continue;
    const rect = page.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const score = dy * 10 + dx;
    if (score < bestScore) {
      bestIndex = i;
      bestScore = score;
      bestRect = rect;
    }
  }
  if (bestIndex < 0 || !bestRect) return null;
  return {
    pageIndex: bestIndex,
    relX: clamp((clientX - bestRect.left) / bestRect.width, 0, 1),
    relY: clamp((clientY - bestRect.top) / bestRect.height, 0, 1),
    clientX,
    clientY,
  };
}

function makeViewportCenterAnchor(
  root: HTMLDivElement,
  pages: (HTMLDivElement | null)[],
): ViewportZoomAnchor | null {
  const rect = root.getBoundingClientRect();
  return makeViewportZoomAnchor(
    pages,
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
}

function preserveViewportZoomAnchor(
  root: HTMLDivElement,
  page: HTMLDivElement,
  anchor: ViewportZoomAnchor,
) {
  const rect = page.getBoundingClientRect();
  const nextClientX = rect.left + anchor.relX * rect.width;
  const nextClientY = rect.top + anchor.relY * rect.height;
  root.scrollLeft += nextClientX - anchor.clientX;
  root.scrollTop += nextClientY - anchor.clientY;
}

function nearestDocxPage(
  root: HTMLDivElement,
  pages: (HTMLDivElement | null)[],
): number {
  const rootRect = root.getBoundingClientRect();
  const center = rootRect.top + rootRect.height / 2;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (!page) continue;
    const rect = page.getBoundingClientRect();
    const pageCenter = rect.top + rect.height / 2;
    const distance = Math.abs(pageCenter - center);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

function scrollDocxPage(
  pages: (HTMLDivElement | null)[],
  pageIndex: number,
) {
  const target = pages[clampInt(pageIndex, 0, Math.max(0, pages.length - 1))];
  target?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function OoxmlView({ url, format, quote, onScrolled }: {
  url: string;
  format: SingleCanvasOoxmlKind;
  quote: string | null;
  onScrolled?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const viewerRef = useRef<OoxmlViewerInstance | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [position, setPosition] = useState({ current: 0, total: 0 });
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [renderKey, setRenderKey] = useState(0);
  const zoom = useViewportWheelZoom(scrollRef, pageRefs, {
    resetKey: `${format}:${url}`,
    applyZoom: (value) => applyVisualPageScale(pageRefs.current, value),
  });
  const quoteState = useQuoteJump(
    hostRef,
    format !== "xlsx" && ready && renderKey > 0
      ? `${format}:${url}:${renderKey}`
      : null,
    quote,
    onScrolled,
  );

  useEffect(() => {
    let cancelled = false;
    let reportedError = false;
    const rafs: number[] = [];
    setReady(false);
    setErr(null);
    setPosition({ current: 0, total: 0 });
    setSheetNames([]);
    setRenderKey(0);

    const reportError = (error: unknown) => {
      reportedError = true;
      if (!cancelled) {
        setErr(error instanceof Error ? error.message : String(error));
      }
    };
    const refreshZoomGeometry = () => {
      const page = pageRefs.current[0];
      if (!page) return;
      refreshVisualPageBase(page);
      applyVisualPageScale(pageRefs.current, zoom.zoomRef.current);
    };
    const noteRendered = () => {
      const handle = window.requestAnimationFrame(() => {
        if (!cancelled) {
          refreshZoomGeometry();
          setRenderKey((n) => n + 1);
        }
      });
      rafs.push(handle);
    };

    (async () => {
      try {
        const host = hostRef.current;
        if (!host) return;
        if (format === "pptx") {
          const canvas = ensureOoxmlCanvas(host, canvasRef.current);
          if (!canvas) return;
          const { PptxViewer } = await import("@silurus/ooxml/pptx");
          if (cancelled) return;
          const viewer = new PptxViewer(canvas, {
            enableTextSelection: true,
            onError: reportError,
            onSlideChange: (index, total) => {
              if (cancelled) return;
              setPosition({ current: index, total });
              noteRendered();
            },
          });
          viewerRef.current = viewer;
          await viewer.load(url);
        } else {
          host.replaceChildren();
          const { XlsxViewer } = await import("@silurus/ooxml/xlsx");
          if (cancelled) return;
          const viewer = new XlsxViewer(host, {
            onError: reportError,
            onReady: (names) => {
              if (!cancelled) {
                setSheetNames(names);
                setPosition({ current: 0, total: names.length });
                noteRendered();
              }
            },
            onSheetChange: (index, total) => {
              if (!cancelled) {
                setPosition({ current: index, total });
                noteRendered();
              }
            },
          });
          viewerRef.current = viewer;
          await viewer.load(url);
        }
        if (!cancelled && !reportedError) setReady(true);
      } catch (error) {
        reportError(error);
      }
    })();

    return () => {
      cancelled = true;
      rafs.forEach((handle) => window.cancelAnimationFrame(handle));
      const viewer = viewerRef.current;
      viewerRef.current = null;
      try {
        viewer?.destroy();
      } catch {
        /* Best-effort cleanup for third-party viewer teardown. */
      }
      const host = hostRef.current;
      const canvas = canvasRef.current;
      if (format === "xlsx") {
        host?.replaceChildren();
      } else if (host && canvas && !host.contains(canvas)) {
        host.appendChild(canvas);
      }
    };
  }, [format, url]);

  const canPrev = ready && position.total > 0 && position.current > 0;
  const canNext = ready && position.total > 0 && position.current < position.total - 1;
  const label = `${ooxmlPositionLabel(format, position, sheetNames)} · ${Math.round(zoom.zoom * 100)}%`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-subtle">
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border bg-bg px-3 text-xs text-fg-muted">
        <button
          type="button"
          title="Previous"
          disabled={!canPrev}
          onClick={() => void ooxmlPrev(format, viewerRef.current)}
          className="rounded border border-border p-1 hover:bg-bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="min-w-28 text-center tabular-nums">{label}</span>
        <button
          type="button"
          title="Next"
          disabled={!canNext}
          onClick={() => void ooxmlNext(format, viewerRef.current)}
          className="rounded border border-border p-1 hover:bg-bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        {quoteState.banner}
        <div className="flex min-h-full w-full justify-center p-4">
          <div
            ref={(el) => { pageRefs.current[0] = el; }}
            className="inline-flex justify-center"
          >
            <div
              ref={hostRef}
              className={
                format === "xlsx"
                  ? "h-[640px] w-[960px] bg-white shadow-sm"
                  : "inline-block"
              }
            >
              {format !== "xlsx" && (
                <canvas
                  ref={canvasRef}
                  className="block max-w-full bg-white shadow-sm"
                  style={{ width: "min(100%, 960px)" }}
                />
              )}
            </div>
          </div>
        </div>
        {!ready && !err && (
          <div className="absolute inset-0 z-20 bg-bg/80">
            <ViewerLoading />
          </div>
        )}
        {err && (
          <div className="absolute inset-0 z-20 bg-bg">
            <ViewerError msg={err} />
          </div>
        )}
      </div>
    </div>
  );
}

function ensureOoxmlCanvas(
  host: HTMLDivElement,
  canvas: HTMLCanvasElement | null,
): HTMLCanvasElement | null {
  if (!canvas) return null;
  if (!host.contains(canvas)) host.appendChild(canvas);
  return canvas;
}

function ooxmlPositionLabel(
  format: SingleCanvasOoxmlKind,
  position: { current: number; total: number },
  sheetNames: string[],
): string {
  const total = position.total;
  if (total <= 0) {
    return format === "pptx" ? "Slide" : "Sheet";
  }
  if (format === "xlsx") {
    const name = sheetNames[position.current];
    return name ? `${name} (${position.current + 1}/${total})` : `Sheet ${position.current + 1}/${total}`;
  }
  return `Slide ${position.current + 1}/${total}`;
}

async function ooxmlPrev(
  format: SingleCanvasOoxmlKind,
  viewer: OoxmlViewerInstance | null,
): Promise<void> {
  if (!viewer) return;
  if (format === "pptx") await (viewer as PptxViewerInstance).prevSlide();
  else await (viewer as XlsxViewerInstance).prevSheet();
}

async function ooxmlNext(
  format: SingleCanvasOoxmlKind,
  viewer: OoxmlViewerInstance | null,
): Promise<void> {
  if (!viewer) return;
  if (format === "pptx") await (viewer as PptxViewerInstance).nextSlide();
  else await (viewer as XlsxViewerInstance).nextSheet();
}

function BinaryView({ url, name }: { url: string; name: string }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-fg-muted">
      <FileText size={32} className="text-fg-subtle" />
      <p>{t.library.previewUnavailable}</p>
      <a href={url} download={name}
         className="flex items-center gap-1 rounded-md border border-border bg-bg-subtle px-3 py-1.5 text-xs hover:bg-bg-muted">
        <Download size={12} /> {t.library.download}
      </a>
    </div>
  );
}

function ViewerLoading() {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center text-sm text-fg-muted">
      <Loader2 size={14} className="mr-2 animate-spin" /> {t.common.loading}
    </div>
  );
}
function ViewerError({ msg }: { msg: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-sm text-danger">
      <AlertCircle size={14} className="mr-2" /> {msg}
    </div>
  );
}
function TruncatedBanner() {
  const { t } = useI18n();
  return (
    <div className="border-b border-border bg-bg-subtle px-3 py-1 text-[11px] text-fg-subtle">
      {t.library.truncatedPreview}
    </div>
  );
}
