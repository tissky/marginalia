import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode, type RefObject } from "react";
import {
  FileText,
  Download,
  AlertCircle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Maximize2,
  Printer,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus, prism } from "react-syntax-highlighter/dist/esm/styles/prism";

import { fileEntries } from "@/api/client";
import { MarkdownView } from "@/components/MarkdownView";
import type { FilePreviewText } from "@/types/api";
import { useTheme } from "@/lib/theme";
import { useI18n } from "@/lib/i18n";

type OfficeKind = "docx" | "xlsx" | "pptx";
type SingleCanvasOoxmlKind = Exclude<OfficeKind, "docx">;
const OFFICE_VIEWER_LOAD_TIMEOUT_MS = 30_000;

function officePreviewTimeoutMessage(format: OfficeKind): string {
  return `${format.toUpperCase()} preview did not finish loading. The desktop runtime may be blocking document viewer workers or WebAssembly.`;
}

export function PdfView({ url, page }: { url: string; page: number | null }) {
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

const CLIENT_IMAGE_DECODE_MAX_BYTES = 50 * 1024 * 1024;
const CLIENT_IMAGE_DECODE_MAX_PIXELS = 80_000_000;

type ClientImageDecodeKind = "native" | "tiff" | "heic";

type DecodedImageState =
  | { status: "idle" | "loading"; src: null; error: null }
  | { status: "ready"; src: string; error: null }
  | { status: "error"; src: null; error: string };

function imageDecodeKind(name: string): ClientImageDecodeKind {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "tif" || ext === "tiff") return "tiff";
  if (ext === "heic" || ext === "heif") return "heic";
  return "native";
}

export function ImageView({ url, name, sizeBytes }: { url: string; name: string; sizeBytes?: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const decodeKind = useMemo(() => imageDecodeKind(name), [name]);
  const decoded = useClientDecodedImage(url, decodeKind, sizeBytes);
  const imageSrc = decodeKind === "native" ? url : decoded.src;
  const zoom = useViewportWheelZoom(scrollRef, pageRefs, {
    resetKey: `${url}:${decodeKind}:${imageSrc || "pending"}`,
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
        {decodeKind !== "native" && decoded.status === "loading" && <ViewerLoading />}
        {decodeKind !== "native" && decoded.status === "error" && <ViewerError msg={decoded.error} />}
        {imageSrc && (
          <div className="flex min-h-full w-full items-center justify-center p-4">
            <div
              ref={(el) => { pageRefs.current[0] = el; }}
              className="inline-flex justify-center"
            >
              <div className="inline-block">
                <img
                  src={imageSrc}
                  className="block max-h-full max-w-full object-contain"
                  alt=""
                  onLoad={refreshImageZoom}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function useClientDecodedImage(
  url: string,
  kind: ClientImageDecodeKind,
  sizeBytes?: number,
): DecodedImageState {
  const [state, setState] = useState<DecodedImageState>(() => (
    kind === "native"
      ? { status: "ready", src: url, error: null }
      : { status: "idle", src: null, error: null }
  ));

  useEffect(() => {
    if (kind === "native") {
      setState({ status: "ready", src: url, error: null });
      return;
    }
    if (sizeBytes != null && sizeBytes > CLIENT_IMAGE_DECODE_MAX_BYTES) {
      setState({
        status: "error",
        src: null,
        error: "TIFF/HEIC preview is limited to files up to 50 MB.",
      });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading", src: null, error: null });

    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        if (blob.size > CLIENT_IMAGE_DECODE_MAX_BYTES) {
          throw new Error("TIFF/HEIC preview is limited to files up to 50 MB.");
        }
        const preview = kind === "heic"
          ? await decodeHeicPreview(blob)
          : await decodeTiffPreview(await blob.arrayBuffer());
        objectUrl = URL.createObjectURL(preview);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
          return;
        }
        setState({ status: "ready", src: objectUrl, error: null });
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            src: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [kind, sizeBytes, url]);

  return state;
}

async function decodeHeicPreview(blob: Blob): Promise<Blob> {
  const { default: heic2any } = await import("heic2any");
  const converted = await heic2any({ blob, toType: "image/png" });
  const first = Array.isArray(converted) ? converted[0] : converted;
  if (!first) throw new Error("HEIC image did not produce a preview.");
  return first;
}

async function decodeTiffPreview(buffer: ArrayBuffer): Promise<Blob> {
  const UTIF = await import("utif");
  const ifds = UTIF.decode(buffer);
  const ifd = ifds[0];
  if (!ifd) throw new Error("TIFF file has no image frames.");
  const rawWidth = Number(ifd.width ?? (ifd.t256 as number[] | undefined)?.[0] ?? 0);
  const rawHeight = Number(ifd.height ?? (ifd.t257 as number[] | undefined)?.[0] ?? 0);
  if (rawWidth > 0 && rawHeight > 0 && rawWidth * rawHeight > CLIENT_IMAGE_DECODE_MAX_PIXELS) {
    throw new Error("TIFF preview is limited to images up to 80 megapixels.");
  }
  UTIF.decodeImage(buffer, ifd);
  const width = Number(ifd.width || rawWidth);
  const height = Number(ifd.height || rawHeight);
  if (!width || !height) throw new Error("TIFF image has invalid dimensions.");
  if (width * height > CLIENT_IMAGE_DECODE_MAX_PIXELS) {
    throw new Error("TIFF preview is limited to images up to 80 megapixels.");
  }
  const rgba = UTIF.toRGBA8(ifd);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available.");
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(rgba), width, height),
    0,
    0,
  );
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!out) throw new Error("TIFF image could not be converted to PNG.");
  return out;
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

function usePreviewText(entryId: string, maxChars = 2_000_000) {
  const [preview, setPreview] = useState<FilePreviewText | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPreview(null); setErr(null);
    fileEntries.previewText(entryId, maxChars)
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [entryId, maxChars]);
  return {
    text: preview?.text ?? null,
    err,
    truncated: preview?.truncated ?? false,
  };
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

function isEditableEventTarget(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  return Boolean(el?.closest('input, textarea, select, [contenteditable="true"]'));
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
const VIEWER_ZOOM_STEPS = [0.45, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];

function nextViewportZoomStep(
  current: number,
  direction: -1 | 1,
  min = VIEWER_MIN_ZOOM,
  max = VIEWER_MAX_ZOOM,
): number {
  const steps = VIEWER_ZOOM_STEPS.filter((step) => step >= min && step <= max);
  if (direction > 0) {
    return steps.find((step) => step > current + 0.001) ?? max;
  }
  return [...steps].reverse().find((step) => step < current - 0.001) ?? min;
}

function formatZoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

function useViewportWheelZoom(
  rootRef: RefObject<HTMLDivElement>,
  pagesRef: MutableRefObject<(HTMLDivElement | null)[]>,
  opts: {
    resetKey: string;
    min?: number;
    max?: number;
    applyZoom?: (zoom: number) => void;
    onWheelZoom?: () => void;
    onZoomingChange?: (zooming: boolean) => void;
    onZoomSettled?: (zoom: number) => void;
  },
) {
  const min = opts.min ?? VIEWER_MIN_ZOOM;
  const max = opts.max ?? VIEWER_MAX_ZOOM;
  const applyZoomRef = useRef(opts.applyZoom);
  const onWheelZoomRef = useRef(opts.onWheelZoom);
  const onZoomingChangeRef = useRef(opts.onZoomingChange);
  const onZoomSettledRef = useRef(opts.onZoomSettled);
  const zoomRef = useRef(1);
  const zoomingRef = useRef(false);
  const zoomFrameRef = useRef<number | null>(null);
  const pendingZoomRef = useRef(1);
  const pendingAnchorRef = useRef<ViewportZoomAnchor | null>(null);
  const zoomLabelFrameRef = useRef<number | null>(null);
  const zoomLabelValueRef = useRef(1);
  const zoomSettledRef = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    applyZoomRef.current = opts.applyZoom;
    onWheelZoomRef.current = opts.onWheelZoom;
    onZoomingChangeRef.current = opts.onZoomingChange;
    onZoomSettledRef.current = opts.onZoomSettled;
  });

  useEffect(() => {
    zoomRef.current = 1;
    pendingZoomRef.current = 1;
    pendingAnchorRef.current = null;
    zoomLabelValueRef.current = 1;
    zoomingRef.current = false;
    setZoom(1);
    applyZoomRef.current?.(1);
    onZoomingChangeRef.current?.(false);
    return () => {
      if (zoomFrameRef.current != null) {
        window.cancelAnimationFrame(zoomFrameRef.current);
        zoomFrameRef.current = null;
      }
      if (zoomLabelFrameRef.current != null) {
        window.cancelAnimationFrame(zoomLabelFrameRef.current);
        zoomLabelFrameRef.current = null;
      }
      if (zoomSettledRef.current != null) {
        window.clearTimeout(zoomSettledRef.current);
        zoomSettledRef.current = null;
      }
      if (zoomingRef.current) {
        zoomingRef.current = false;
        onZoomingChangeRef.current?.(false);
      }
    };
  }, [opts.resetKey]);

  const applyZoomValue = (next: number, anchor: ViewportZoomAnchor | null) => {
    const root = rootRef.current;
    if (!root) return;
    const applyZoom = applyZoomRef.current ?? ((value: number) => {
      applyVisualPageScale(pagesRef.current, value);
    });
    applyZoom(next);
    if (anchor) {
      const page = pagesRef.current[anchor.pageIndex];
      if (page) preserveViewportZoomAnchor(root, page, anchor);
    }
    scheduleViewportZoomLabel(zoomLabelFrameRef, zoomLabelValueRef, setZoom, next);
  };

  const setZoomTo = (value: number) => {
    const next = clamp(value, min, max);
    if (Math.abs(next - zoomRef.current) < 0.001) return;
    const root = rootRef.current;
    const anchor = root ? makeViewportCenterAnchor(root, pagesRef.current) : null;
    if (zoomFrameRef.current != null) {
      window.cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = null;
    }
    pendingAnchorRef.current = null;
    pendingZoomRef.current = next;
    zoomRef.current = next;
    if (!zoomingRef.current) {
      zoomingRef.current = true;
      onZoomingChangeRef.current?.(true);
    }
    applyZoomValue(next, anchor);
    if (zoomSettledRef.current != null) {
      window.clearTimeout(zoomSettledRef.current);
      zoomSettledRef.current = null;
    }
    window.requestAnimationFrame(() => {
      if (zoomingRef.current) {
        zoomingRef.current = false;
        onZoomingChangeRef.current?.(false);
      }
      onZoomSettledRef.current?.(zoomRef.current);
    });
  };

  const zoomByStep = (direction: -1 | 1) => {
    setZoomTo(nextViewportZoomStep(zoomRef.current, direction, min, max));
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Match Chromium PDF viewer behavior: coalesce zoom work to frames,
    // then let the renderer catch up after input settles.
    const flushZoomFrame = () => {
      zoomFrameRef.current = null;
      const next = pendingZoomRef.current;
      const anchor = pendingAnchorRef.current;
      pendingAnchorRef.current = null;
      applyZoomValue(next, anchor);
    };
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
      onWheelZoomRef.current?.();
      zoomRef.current = next;
      pendingZoomRef.current = next;
      pendingAnchorRef.current = anchor;
      if (!zoomingRef.current) {
        zoomingRef.current = true;
        onZoomingChangeRef.current?.(true);
      }
      if (zoomFrameRef.current == null) {
        zoomFrameRef.current = window.requestAnimationFrame(flushZoomFrame);
      }
      if (zoomSettledRef.current != null) {
        window.clearTimeout(zoomSettledRef.current);
      }
      zoomSettledRef.current = window.setTimeout(() => {
        zoomSettledRef.current = null;
        if (zoomFrameRef.current != null) {
          window.cancelAnimationFrame(zoomFrameRef.current);
          flushZoomFrame();
        }
        if (zoomingRef.current) {
          zoomingRef.current = false;
          onZoomingChangeRef.current?.(false);
        }
        onZoomSettledRef.current?.(zoomRef.current);
      }, 320);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [max, min, pagesRef, rootRef]);

  return { zoom, zoomRef, setZoom: setZoomTo, zoomIn: () => zoomByStep(1), zoomOut: () => zoomByStep(-1) };
}

interface JumpProps {
  quote: string | null;
  lineRange: { start: number; end: number } | null;
  onScrolled?: () => void;
}

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
  opts?: { allowMissing?: boolean; consumeOnMissing?: boolean },
) {
  const allowMissing = opts?.allowMissing ?? true;
  const consumeOnMissing = opts?.consumeOnMissing ?? true;
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
          onScrolled?.();
        } else if (allowMissing) {
          setHit("missing");
          if (consumeOnMissing) onScrolled?.();
        } else {
          setHit(null);
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(handle1);
      if (handle2 != null) window.cancelAnimationFrame(handle2);
      if (cleanup != null) window.clearTimeout(cleanup);
      marks.forEach(unwrapMark);
    };
  }, [allowMissing, consumeOnMissing, content, quote, onScrolled, ref]);
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

function ViewerToolbarButton({
  title,
  disabled,
  active,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border text-fg-muted transition-colors " +
        (active
          ? "border-accent/50 bg-accent/10 text-accent"
          : "border-border hover:bg-bg-muted disabled:cursor-not-allowed disabled:opacity-40")
      }
    >
      {children}
    </button>
  );
}

interface OfficeViewerToolbarProps {
  ready: boolean;
  name: string;
  downloadUrl: string;
  positionInput: string;
  total: number;
  positionLabel?: string | null;
  inputLabel: string;
  prevTitle: string;
  nextTitle: string;
  prevIcon: ReactNode;
  nextIcon: ReactNode;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onPositionInputChange: (value: string) => void;
  onCommitPositionInput: () => void;
  onResetPositionInput: () => void;
  zoomLabel: string;
  canZoomOut: boolean;
  canZoomIn: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  fitActive: boolean;
  onFitWidth: () => void;
  canPrint: boolean;
  onPrint: () => void;
}

function OfficeViewerToolbar({
  ready,
  name,
  downloadUrl,
  positionInput,
  total,
  positionLabel,
  inputLabel,
  prevTitle,
  nextTitle,
  prevIcon,
  nextIcon,
  canPrev,
  canNext,
  onPrev,
  onNext,
  onPositionInputChange,
  onCommitPositionInput,
  onResetPositionInput,
  zoomLabel,
  canZoomOut,
  canZoomIn,
  onZoomOut,
  onZoomIn,
  fitActive,
  onFitWidth,
  canPrint,
  onPrint,
}: OfficeViewerToolbarProps) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-bg px-3 text-xs text-fg-muted">
      <div className="flex items-center gap-1">
        <ViewerToolbarButton title={prevTitle} disabled={!canPrev} onClick={onPrev}>
          {prevIcon}
        </ViewerToolbarButton>
        <input
          value={positionInput}
          disabled={!ready || total <= 0}
          onChange={(event) => onPositionInputChange(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={onCommitPositionInput}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              onResetPositionInput();
              event.currentTarget.blur();
            }
          }}
          inputMode="numeric"
          className="h-7 w-12 rounded border border-border bg-bg px-1.5 text-center text-xs text-fg-base tabular-nums outline-none focus:border-accent disabled:opacity-50"
          aria-label={inputLabel}
        />
        <span className="min-w-10 text-center tabular-nums">/ {total || "-"}</span>
        <ViewerToolbarButton title={nextTitle} disabled={!canNext} onClick={onNext}>
          {nextIcon}
        </ViewerToolbarButton>
        {positionLabel ? (
          <span className="ml-1 max-w-40 truncate text-fg-subtle" title={positionLabel}>
            {positionLabel}
          </span>
        ) : null}
      </div>
      <div className="h-5 w-px shrink-0 bg-border" />
      <div className="flex items-center gap-1">
        <ViewerToolbarButton title="Zoom out" disabled={!canZoomOut} onClick={onZoomOut}>
          <ZoomOut size={14} />
        </ViewerToolbarButton>
        <span className="min-w-14 text-center tabular-nums">{zoomLabel}</span>
        <ViewerToolbarButton title="Zoom in" disabled={!canZoomIn} onClick={onZoomIn}>
          <ZoomIn size={14} />
        </ViewerToolbarButton>
        <ViewerToolbarButton
          title="Fit to width"
          disabled={!ready}
          active={fitActive}
          onClick={onFitWidth}
        >
          <Maximize2 size={14} />
        </ViewerToolbarButton>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <ViewerToolbarButton title="Print" disabled={!canPrint} onClick={onPrint}>
          <Printer size={14} />
        </ViewerToolbarButton>
        <a
          href={downloadUrl}
          download={name}
          title="Download"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border text-fg-muted transition-colors hover:bg-bg-muted"
        >
          <Download size={14} />
        </a>
      </div>
    </div>
  );
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
type PptxPresentationInstance = import("@silurus/ooxml/pptx").PptxPresentation;
type PptxPresentationData = import("@silurus/ooxml/pptx").Presentation;
type PptxSlide = import("@silurus/ooxml/pptx").Slide;
type PptxTextBody = import("@silurus/ooxml/pptx").TextBody;
type PptxChartElement = import("@silurus/ooxml/pptx").ChartElement;
type XlsxViewerInstance = import("@silurus/ooxml/xlsx").XlsxViewer;
type EpubBookInstance = import("epubjs").Book;
type EpubRenditionInstance = import("epubjs").Rendition;
type EpubLocation = import("epubjs").Location;
type OoxmlViewerInstance =
  | PptxViewerInstance
  | XlsxViewerInstance;
type PptxPresentationInternal = {
  _presentation?: PptxPresentationData | null;
};

type PptxViewerInternal = {
  engine?: PptxPresentationInstance | null;
};

interface PptxSlideSearchEntry {
  text: string;
  normalized: string;
}

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
const DOCX_VIEWPORT_SIDE_PADDING = 48;

type DocxFitMode = "none" | "width";

function roundDocxRenderZoom(zoom: number): number {
  return Math.round(clamp(zoom, DOCX_MIN_ZOOM, DOCX_MAX_ZOOM) * 100) / 100;
}

function docxFitWidthZoom(root: HTMLDivElement): number {
  const available = Math.max(240, root.clientWidth - DOCX_VIEWPORT_SIDE_PADDING);
  return roundDocxRenderZoom(available / DOCX_BASE_WIDTH);
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

export function OfficeDocumentView({ url, format, name, downloadUrl, quote, page, onScrolled }: {
  url: string;
  format: OfficeKind;
  name: string;
  downloadUrl: string;
  quote: string | null;
  page: number | null;
  onScrolled?: () => void;
}) {
  if (format === "docx") {
    return (
      <DocxScrollView
        url={url}
        name={name}
        downloadUrl={downloadUrl}
        quote={quote}
        onScrolled={onScrolled}
      />
    );
  }
  return (
    <OoxmlView
      url={url}
      format={format}
      name={name}
      downloadUrl={downloadUrl}
      quote={quote}
      page={format === "pptx" ? page : null}
      onScrolled={onScrolled}
    />
  );
}
function DocxScrollView({ url, name, downloadUrl, quote, onScrolled }: {
  url: string;
  name: string;
  downloadUrl: string;
  quote: string | null;
  onScrolled?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<DocxDocumentInstance | null>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rasterZoomRef = useRef(1);
  const docxZoomingRef = useRef(false);
  const quoteRef = useRef<string | null>(quote);
  const [ready, setReady] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderedPageCount, setRenderedPageCount] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [pageInput, setPageInput] = useState("1");
  const [fitMode, setFitMode] = useState<DocxFitMode>("none");
  const [renderRequestZoom, setRenderRequestZoom] = useState(1);
  const [renderKey, setRenderKey] = useState(0);

  const updateCurrentPageFromViewport = () => {
    const root = scrollRef.current;
    if (!root) return;
    setCurrentPage(nearestDocxPage(root, pageRefs.current));
  };

  const zoom = useViewportWheelZoom(scrollRef, pageRefs, {
    resetKey: `docx:${url}`,
    min: DOCX_MIN_ZOOM,
    max: DOCX_MAX_ZOOM,
    applyZoom: (value) => applyDocxViewportZoom(
      pageRefs.current,
      value,
      rasterZoomRef.current,
    ),
    onWheelZoom: () => setFitMode("none"),
    onZoomingChange: (zooming) => {
      docxZoomingRef.current = zooming;
      if (!zooming) {
        window.requestAnimationFrame(updateCurrentPageFromViewport);
      }
    },
    onZoomSettled: (value) => {
      const next = roundDocxRenderZoom(value);
      setRenderRequestZoom((prev) => Math.abs(prev - next) < 0.005 ? prev : next);
    },
  });

  const setManualZoom = (value: number) => {
    setFitMode("none");
    zoom.setZoom(roundDocxRenderZoom(value));
  };

  const applyFitWidth = () => {
    const root = scrollRef.current;
    if (!root) return;
    setFitMode("width");
    zoom.setZoom(docxFitWidthZoom(root));
  };

  const toggleFitWidth = () => {
    if (fitMode === "width") {
      setManualZoom(1);
    } else {
      applyFitWidth();
    }
  };

  const commitPageInput = () => {
    if (pageCount <= 0) return;
    const page = clampInt(parseInt(pageInput, 10), 1, pageCount);
    if (!Number.isFinite(page)) {
      setPageInput(String(currentPage + 1));
      return;
    }
    setPageInput(String(page));
    scrollDocxPage(pageRefs.current, page - 1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isEditableEventTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setFitMode("none");
        zoom.zoomIn();
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setFitMode("none");
        zoom.zoomOut();
      } else if (event.key === "0") {
        event.preventDefault();
        setManualZoom(1);
      }
      return;
    }
    if (event.altKey || !ready || pageCount <= 0) return;
    if (event.key === "PageUp") {
      event.preventDefault();
      scrollDocxPage(pageRefs.current, currentPage - 1);
    } else if (event.key === "PageDown" || event.key === " ") {
      event.preventDefault();
      scrollDocxPage(pageRefs.current, currentPage + 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      scrollDocxPage(pageRefs.current, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      scrollDocxPage(pageRefs.current, pageCount - 1);
    }
  };

  useEffect(() => {
    quoteRef.current = quote;
  }, [quote]);

  const initialRenderComplete = pageCount > 0 && renderedPageCount >= pageCount;
  const quoteState = useQuoteJump(
    scrollRef,
    ready && renderKey > 0 ? `docx:${url}:${renderKey}` : null,
    quote,
    onScrolled,
    { allowMissing: initialRenderComplete, consumeOnMissing: initialRenderComplete },
  );

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (!cancelled) setErr(officePreviewTimeoutMessage("docx"));
    }, OFFICE_VIEWER_LOAD_TIMEOUT_MS);
    setReady(false);
    setRendering(false);
    setErr(null);
    setPageCount(0);
    setCurrentPage(0);
    setRenderedPageCount(0);
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
        window.clearTimeout(timeout);
      } catch (error) {
        if (!cancelled) {
          setErr(error instanceof Error ? error.message : String(error));
        }
        window.clearTimeout(timeout);
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      docRef.current?.destroy();
      docRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    setPageInput(pageCount > 0 ? String(currentPage + 1) : "");
  }, [currentPage, pageCount]);

  useEffect(() => {
    if (fitMode !== "width") return;
    const root = scrollRef.current;
    if (!root) return;
    let frame: number | null = null;
    const sync = () => {
      frame = null;
      zoom.setZoom(docxFitWidthZoom(root));
    };
    const schedule = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(sync);
    };
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(schedule)
      : null;
    resizeObserver?.observe(root);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, [fitMode]);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      if (docxZoomingRef.current) return;
      updateCurrentPageFromViewport();
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
            const rendered = await renderDocxPage(
              pageEl,
              doc,
              i,
              renderRequestZoom,
              () => zoom.zoomRef.current,
              () => cancelled,
            );
            if (!rendered) return;
            const completedThrough = i + 1;
            setRenderedPageCount((prev) => Math.max(prev, completedThrough));
            if (quoteRef.current || completedThrough === 1 || completedThrough === pageCount) {
              setRenderKey((n) => n + 1);
            }
            if (completedThrough < pageCount) {
              await waitForNextFrame();
            }
          }
          if (!cancelled) {
            rasterZoomRef.current = renderRequestZoom;
            applyDocxViewportZoom(pageRefs.current, zoom.zoomRef.current, rasterZoomRef.current);
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
  const canZoomOut = ready && zoom.zoom > DOCX_MIN_ZOOM + 0.001;
  const canZoomIn = ready && zoom.zoom < DOCX_MAX_ZOOM - 0.001;
  const zoomLabel = formatZoomPercent(zoom.zoom);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-subtle"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <OfficeViewerToolbar
        ready={ready}
        name={name}
        downloadUrl={downloadUrl}
        positionInput={pageInput}
        total={pageCount}
        inputLabel="Page number"
        prevTitle="Previous page"
        nextTitle="Next page"
        prevIcon={<ChevronUp size={14} />}
        nextIcon={<ChevronDown size={14} />}
        canPrev={canPrev}
        canNext={canNext}
        onPrev={() => scrollDocxPage(pageRefs.current, currentPage - 1)}
        onNext={() => scrollDocxPage(pageRefs.current, currentPage + 1)}
        onPositionInputChange={setPageInput}
        onCommitPositionInput={commitPageInput}
        onResetPositionInput={() => setPageInput(String(currentPage + 1))}
        zoomLabel={zoomLabel}
        canZoomOut={canZoomOut}
        canZoomIn={canZoomIn}
        onZoomOut={() => { setFitMode("none"); zoom.zoomOut(); }}
        onZoomIn={() => { setFitMode("none"); zoom.zoomIn(); }}
        fitActive={fitMode === "width"}
        onFitWidth={toggleFitWidth}
        canPrint={ready && renderedPageCount > 0}
        onPrint={() => printRenderedCanvasPages(pageRefs.current, name || "document")}
      />
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
        {(!ready || (rendering && renderedPageCount === 0)) && !err && (
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
  renderZoom: number,
  getViewportZoom: () => number,
  shouldCancel?: () => boolean,
): Promise<boolean> {
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
    width: DOCX_BASE_WIDTH * renderZoom,
    dpr,
    onTextRun: (run: DocxTextRunInfo) => runs.push(run),
  });
  if (shouldCancel?.()) return false;
  buildDocxTextLayer(textLayer, canvas, runs);
  if (shouldCancel?.()) return false;
  const rasterWidth = parseCssPixels(canvas.style.width) || canvas.width / dpr;
  const rasterHeight = parseCssPixels(canvas.style.height) || canvas.height / dpr;
  const previousBaseWidth = Number(pageEl.dataset.docxBaseWidth || 0);
  const previousBaseHeight = Number(pageEl.dataset.docxBaseHeight || 0);
  const logicalWidth = previousBaseWidth || rasterWidth / renderZoom;
  const logicalHeight = previousBaseHeight || rasterHeight / renderZoom;
  pageEl.dataset.docxBaseWidth = String(logicalWidth);
  pageEl.dataset.docxBaseHeight = String(logicalHeight);
  pageEl.dataset.docxRasterZoom = String(renderZoom);
  pageEl.style.overflow = "visible";
  wrapper.style.transformOrigin = "top center";
  wrapper.style.willChange = "transform";
  setDocxPageScale(pageEl, wrapper, logicalWidth, logicalHeight, getViewportZoom(), renderZoom);
  pageEl.replaceChildren(wrapper);
  return true;
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

function applyDocxViewportZoom(
  pages: (HTMLDivElement | null)[],
  viewportZoom: number,
  fallbackRasterZoom: number,
) {
  for (const page of pages) {
    if (!page) continue;
    const baseWidth = Number(page.dataset.docxBaseWidth || 0);
    const baseHeight = Number(page.dataset.docxBaseHeight || 0);
    const pageRasterZoom = Number(page.dataset.docxRasterZoom || fallbackRasterZoom || 1);
    const wrapper = page.firstElementChild as HTMLElement | null;
    if (!baseWidth || !baseHeight || !pageRasterZoom || !wrapper) continue;
    setDocxPageScale(page, wrapper, baseWidth, baseHeight, viewportZoom, pageRasterZoom);
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
  viewportZoom: number,
  rasterZoom: number,
) {
  const safeViewportZoom = clamp(viewportZoom, DOCX_MIN_ZOOM, DOCX_MAX_ZOOM);
  const safeRasterZoom = clamp(rasterZoom, DOCX_MIN_ZOOM, DOCX_MAX_ZOOM);
  const transformScale = safeViewportZoom / safeRasterZoom;
  page.style.width = `${baseWidth * safeViewportZoom}px`;
  page.style.height = `${baseHeight * safeViewportZoom}px`;
  wrapper.style.transformOrigin = "top center";
  wrapper.style.transform = Math.abs(transformScale - 1) < 0.001
    ? ""
    : `scale(${transformScale})`;
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


function printRenderedCanvasPages(
  pages: (HTMLDivElement | null)[],
  title: string,
) {
  const canvases = pages
    .map((page) => page?.querySelector("canvas") ?? null)
    .filter((canvas): canvas is HTMLCanvasElement => canvas != null);
  if (canvases.length === 0) return;
  const printWindow = window.open("", "_blank", "width=960,height=720");
  if (!printWindow) return;
  const doc = printWindow.document;
  doc.open();
  doc.write("<!doctype html><html><head><title></title></head><body></body></html>");
  doc.close();
  doc.title = title;
  const style = doc.createElement("style");
  style.textContent =
    "@page{margin:12mm}body{margin:0;background:#fff}" +
    "img{display:block;max-width:100%;height:auto;margin:0 auto 12mm;page-break-after:always}" +
    "img:last-child{page-break-after:auto;margin-bottom:0}";
  doc.head.appendChild(style);
  let remaining = canvases.length;
  const maybePrint = () => {
    remaining -= 1;
    if (remaining > 0) return;
    window.setTimeout(() => {
      printWindow.focus();
      printWindow.print();
    }, 50);
  };
  for (const canvas of canvases) {
    const img = doc.createElement("img");
    img.onload = maybePrint;
    img.onerror = maybePrint;
    img.src = canvas.toDataURL("image/png");
    doc.body.appendChild(img);
  }
}
function OoxmlView({ url, format, name, downloadUrl, quote, page, onScrolled }: {
  url: string;
  format: SingleCanvasOoxmlKind;
  name: string;
  downloadUrl: string;
  quote: string | null;
  page: number | null;
  onScrolled?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const thumbnailCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const thumbnailButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const viewerRef = useRef<OoxmlViewerInstance | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [position, setPosition] = useState({ current: 0, total: 0 });
  const [positionInput, setPositionInput] = useState("1");
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [fitMode, setFitMode] = useState<DocxFitMode>("none");
  const [renderKey, setRenderKey] = useState(0);
  const [pptxSlideSearch, setPptxSlideSearch] = useState<PptxSlideSearchEntry[] | null>(null);
  const zoom = useViewportWheelZoom(scrollRef, pageRefs, {
    resetKey: `${format}:${url}`,
    applyZoom: (value) => {
      if (format === "xlsx") {
        (viewerRef.current as XlsxViewerInstance | null)?.setScale(value);
      } else {
        applyVisualPageScale(pageRefs.current, value);
      }
    },
    onWheelZoom: () => setFitMode("none"),
  });
  const pptxQuoteSlide = useMemo<number | null | undefined>(() => {
    if (format !== "pptx" || !quote) return null;
    if (!pptxSlideSearch) return undefined;
    return findPptxQuoteSlide(pptxSlideSearch, quote);
  }, [format, pptxSlideSearch, quote]);
  const pptxQuoteReady = format !== "pptx" || !quote || pptxQuoteSlide !== undefined;
  const quoteJumpContent = format !== "xlsx" && ready && renderKey > 0 && (
    format !== "pptx" || !quote || (
      pptxQuoteReady && (pptxQuoteSlide == null || pptxQuoteSlide === position.current)
    )
  )
    ? `${format}:${url}:${position.current}:${renderKey}`
    : null;
  const quoteState = useQuoteJump(
    hostRef,
    quoteJumpContent,
    quote,
    onScrolled,
    format === "pptx"
      ? { allowMissing: pptxQuoteReady, consumeOnMissing: pptxQuoteReady }
      : undefined,
  );

  const goToPosition = (index: number) => {
    if (!ready || position.total <= 0) return;
    void ooxmlGoTo(format, viewerRef.current, clampInt(index, 0, position.total - 1));
  };

  useEffect(() => {
    if (format !== "pptx" || quote || page == null || !ready || position.total <= 0) return;
    const target = clampInt(page - 1, 0, position.total - 1);
    if (target === position.current) {
      onScrolled?.();
      return;
    }
    let cancelled = false;
    void ooxmlGoTo(format, viewerRef.current, target).then(() => {
      if (!cancelled) onScrolled?.();
    });
    return () => { cancelled = true; };
  }, [format, onScrolled, page, position.current, position.total, quote, ready]);

  useEffect(() => {
    if (format !== "pptx" || !ready || !quote || pptxQuoteSlide == null || position.total <= 0) return;
    const target = clampInt(pptxQuoteSlide, 0, position.total - 1);
    if (target === position.current) return;
    void ooxmlGoTo(format, viewerRef.current, target);
  }, [format, position.current, position.total, pptxQuoteSlide, quote, ready]);

  const setManualZoom = (value: number) => {
    setFitMode("none");
    zoom.setZoom(value);
  };

  const applyFitWidth = () => {
    const root = scrollRef.current;
    if (!root) return;
    setFitMode("width");
    zoom.setZoom(ooxmlFitWidthZoom(root));
  };

  const toggleFitWidth = () => {
    if (fitMode === "width") setManualZoom(1);
    else applyFitWidth();
  };

  const commitPositionInput = () => {
    if (position.total <= 0) return;
    const parsed = parseInt(positionInput, 10);
    if (!Number.isFinite(parsed)) {
      setPositionInput(String(position.current + 1));
      return;
    }
    const next = clampInt(parsed, 1, position.total);
    setPositionInput(String(next));
    goToPosition(next - 1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isEditableEventTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setFitMode("none");
        zoom.zoomIn();
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setFitMode("none");
        zoom.zoomOut();
      } else if (event.key === "0") {
        event.preventDefault();
        setManualZoom(1);
      }
      return;
    }
    if (event.altKey || !ready || position.total <= 0) return;
    if (event.key === "PageUp" || (format === "pptx" && event.key === "ArrowLeft")) {
      event.preventDefault();
      goToPosition(position.current - 1);
    } else if (event.key === "PageDown" || event.key === " " || (format === "pptx" && event.key === "ArrowRight")) {
      event.preventDefault();
      goToPosition(position.current + 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      goToPosition(0);
    } else if (event.key === "End") {
      event.preventDefault();
      goToPosition(position.total - 1);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let reportedError = false;
    const timeout = window.setTimeout(() => {
      reportedError = true;
      if (!cancelled) setErr(officePreviewTimeoutMessage(format));
    }, OFFICE_VIEWER_LOAD_TIMEOUT_MS);
    const rafs: number[] = [];
    setReady(false);
    setErr(null);
    setPosition({ current: 0, total: 0 });
    setPositionInput("1");
    setSheetNames([]);
    setFitMode("none");
    setRenderKey(0);
    setPptxSlideSearch(null);
    thumbnailCanvasRefs.current = [];
    thumbnailButtonRefs.current = [];

    const reportError = (error: unknown) => {
      reportedError = true;
      window.clearTimeout(timeout);
      if (!cancelled) {
        setErr(error instanceof Error ? error.message : String(error));
      }
    };
    const refreshZoomGeometry = () => {
      const page = pageRefs.current[0];
      if (!page) return;
      if (format !== "xlsx") {
        refreshVisualPageBase(page);
        applyVisualPageScale(pageRefs.current, zoom.zoomRef.current);
      } else {
        (viewerRef.current as XlsxViewerInstance | null)?.setScale(zoom.zoomRef.current);
      }
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
          if (!cancelled) {
            const presentation = (viewer as unknown as PptxViewerInternal).engine;
            setPptxSlideSearch(presentation ? buildPptxSlideSearchIndex(presentation) : []);
          }
        } else {
          host.replaceChildren();
          const { XlsxViewer } = await import("@silurus/ooxml/xlsx");
          if (cancelled) return;
          const viewer = new XlsxViewer(host, {
            showZoomSlider: false,
            zoomMin: VIEWER_MIN_ZOOM,
            zoomMax: VIEWER_MAX_ZOOM,
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
          viewer.setScale(zoom.zoomRef.current);
        }
        if (!cancelled && !reportedError) {
          window.clearTimeout(timeout);
          setReady(true);
        }
      } catch (error) {
        reportError(error);
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
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

  useEffect(() => {
    setPositionInput(position.total > 0 ? String(position.current + 1) : "");
  }, [position.current, position.total]);

  useEffect(() => {
    if (fitMode !== "width") return;
    const root = scrollRef.current;
    if (!root) return;
    let frame: number | null = null;
    const sync = () => {
      frame = null;
      zoom.setZoom(ooxmlFitWidthZoom(root));
    };
    const schedule = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(sync);
    };
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(schedule)
      : null;
    resizeObserver?.observe(root);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, [fitMode]);

  useEffect(() => {
    if (format !== "pptx" || !ready || position.total <= 0) return;
    let cancelled = false;
    let presentation: PptxPresentationInstance | null = null;
    (async () => {
      try {
        const { PptxPresentation } = await import("@silurus/ooxml/pptx");
        presentation = await PptxPresentation.load(url);
        if (cancelled) return;
        for (let i = 0; i < position.total; i += 1) {
          if (cancelled) return;
          const canvas = thumbnailCanvasRefs.current[i];
          if (!canvas) continue;
          await presentation.renderSlide(canvas, i, {
            width: 112,
            dpr: Math.min(window.devicePixelRatio || 1, 2),
          });
        }
      } catch {
        /* Thumbnail rendering is auxiliary; keep the main slide viewer usable. */
      }
    })();
    return () => {
      cancelled = true;
      presentation?.destroy();
    };
  }, [format, ready, position.total, url]);

  useEffect(() => {
    if (format !== "pptx") return;
    thumbnailButtonRefs.current[position.current]?.scrollIntoView({ block: "nearest" });
  }, [format, position.current]);

  const canPrev = ready && position.total > 0 && position.current > 0;
  const canNext = ready && position.total > 0 && position.current < position.total - 1;
  const canZoomOut = ready && zoom.zoom > VIEWER_MIN_ZOOM + 0.001;
  const canZoomIn = ready && zoom.zoom < VIEWER_MAX_ZOOM - 0.001;
  const isPptx = format === "pptx";
  const positionLabel = format === "xlsx" ? sheetNames[position.current] ?? null : null;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-subtle"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <OfficeViewerToolbar
        ready={ready}
        name={name}
        downloadUrl={downloadUrl}
        positionInput={positionInput}
        total={position.total}
        positionLabel={positionLabel}
        inputLabel={isPptx ? "Slide number" : "Sheet number"}
        prevTitle={isPptx ? "Previous slide" : "Previous sheet"}
        nextTitle={isPptx ? "Next slide" : "Next sheet"}
        prevIcon={isPptx ? <ChevronLeft size={14} /> : <ChevronUp size={14} />}
        nextIcon={isPptx ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        canPrev={canPrev}
        canNext={canNext}
        onPrev={() => goToPosition(position.current - 1)}
        onNext={() => goToPosition(position.current + 1)}
        onPositionInputChange={setPositionInput}
        onCommitPositionInput={commitPositionInput}
        onResetPositionInput={() => setPositionInput(String(position.current + 1))}
        zoomLabel={formatZoomPercent(zoom.zoom)}
        canZoomOut={canZoomOut}
        canZoomIn={canZoomIn}
        onZoomOut={() => { setFitMode("none"); zoom.zoomOut(); }}
        onZoomIn={() => { setFitMode("none"); zoom.zoomIn(); }}
        fitActive={fitMode === "width"}
        onFitWidth={toggleFitWidth}
        canPrint={ready && renderKey > 0}
        onPrint={() => printRenderedCanvasPages(pageRefs.current, name || (isPptx ? "presentation" : "workbook"))}
      />
      <div className="flex min-h-0 flex-1">
        {isPptx && (
          <aside className="hidden w-36 shrink-0 overflow-y-auto border-r border-border bg-bg px-2 py-3 md:block">
            <div className="space-y-2">
              {Array.from({ length: position.total }, (_, i) => {
                const active = i === position.current;
                return (
                  <button
                    key={i}
                    ref={(el) => { thumbnailButtonRefs.current[i] = el; }}
                    type="button"
                    onClick={() => goToPosition(i)}
                    className={
                      "block w-full rounded border p-1 text-left transition-colors " +
                      (active
                        ? "border-accent/60 bg-accent/10 text-accent"
                        : "border-border bg-bg-subtle text-fg-muted hover:bg-bg-muted")
                    }
                    title={`Slide ${i + 1}`}
                  >
                    <div className="flex aspect-video w-full items-center justify-center overflow-hidden bg-white shadow-sm">
                      <canvas
                        ref={(el) => { thumbnailCanvasRefs.current[i] = el; }}
                        className="block max-h-full max-w-full"
                      />
                    </div>
                    <div className="mt-1 text-center text-[11px] tabular-nums">{i + 1}</div>
                  </button>
                );
              })}
            </div>
          </aside>
        )}
        <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
          {quoteState.banner}
          <div className={format === "xlsx"
            ? "flex min-h-full w-full p-4"
            : "flex min-h-full w-full justify-center p-4"}
          >
            <div
              ref={(el) => { pageRefs.current[0] = el; }}
              className={format === "xlsx" ? "flex min-h-[560px] w-full" : "inline-flex justify-center"}
            >
              <div
                ref={hostRef}
                className={
                  format === "xlsx"
                    ? "min-h-[560px] w-full min-w-[760px] bg-white shadow-sm"
                    : "inline-block"
                }
              >
                {format !== "xlsx" && (
                  <canvas
                    ref={canvasRef}
                    className="block bg-white shadow-sm"
                    style={{ width: "960px" }}
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

function ooxmlFitWidthZoom(root: HTMLDivElement): number {
  const available = Math.max(240, root.clientWidth - DOCX_VIEWPORT_SIDE_PADDING);
  return Math.round(clamp(available / DOCX_BASE_WIDTH, VIEWER_MIN_ZOOM, VIEWER_MAX_ZOOM) * 100) / 100;
}

function buildPptxSlideSearchIndex(presentation: PptxPresentationInstance): PptxSlideSearchEntry[] {
  const data = (presentation as unknown as PptxPresentationInternal)._presentation;
  if (data?.slides?.length) {
    return data.slides.map((slide, index) => {
      const text = pptxSlideSearchText(slide, presentation.getNotes(index));
      return { text, normalized: normalizeSearchText(text) };
    });
  }
  return Array.from({ length: presentation.slideCount }, (_, index) => {
    const text = presentation.getNotes(index) ?? "";
    return { text, normalized: normalizeSearchText(text) };
  });
}

function pptxSlideSearchText(slide: PptxSlide, notes: string | null): string {
  const parts: string[] = [];
  for (const element of slide.elements) {
    if (element.type === "shape") {
      appendPptxTextBody(parts, element.textBody);
    } else if (element.type === "table") {
      for (const row of element.rows) {
        for (const cell of row.cells) appendPptxTextBody(parts, cell.textBody);
      }
    } else if (element.type === "chart") {
      appendPptxChartText(parts, element);
    }
  }
  appendPptxText(parts, slide.notes ?? notes);
  for (const comment of slide.comments ?? []) appendPptxText(parts, comment.text);
  return parts.join("\n");
}

function appendPptxTextBody(parts: string[], body: PptxTextBody | null): void {
  for (const paragraph of body?.paragraphs ?? []) {
    let text = "";
    for (const run of paragraph.runs) {
      if (run.type === "text") text += run.text;
      else if (run.type === "break") text += "\n";
    }
    appendPptxText(parts, text);
  }
}

function appendPptxChartText(parts: string[], chart: PptxChartElement): void {
  appendPptxText(parts, chart.title);
  appendPptxText(parts, chart.catAxisTitle);
  appendPptxText(parts, chart.valAxisTitle);
  appendPptxText(parts, chart.secondaryValAxis?.title);
  for (const category of chart.categories) appendPptxText(parts, category);
  for (const series of chart.series) {
    appendPptxText(parts, series.name);
    for (const category of series.categories ?? []) appendPptxText(parts, category);
    for (const label of series.dataLabelOverrides ?? []) appendPptxText(parts, label.text);
  }
}

function appendPptxText(parts: string[], value: string | null | undefined): void {
  const text = value?.trim();
  if (text) parts.push(text);
}

function findPptxQuoteSlide(index: PptxSlideSearchEntry[], quote: string): number | null {
  const exact = quote.trim();
  if (exact) {
    for (let i = 0; i < index.length; i += 1) {
      if (index[i].text.includes(exact)) return i;
    }
  }
  const needle = normalizeSearchText(quote);
  if (needle.length < 3) return null;
  for (let i = 0; i < index.length; i += 1) {
    if (index[i].normalized.includes(needle)) return i;
  }
  return null;
}
async function ooxmlGoTo(
  format: SingleCanvasOoxmlKind,
  viewer: OoxmlViewerInstance | null,
  index: number,
): Promise<void> {
  if (!viewer) return;
  if (format === "pptx") await (viewer as PptxViewerInstance).goToSlide(index);
  else await (viewer as XlsxViewerInstance).goToSheet(index);
}
const EPUB_MIN_FONT = 80;
const EPUB_MAX_FONT = 160;
const EPUB_FONT_STEP = 10;
const EPUB_LOCATION_CHARS = 1000;

interface EpubProgress {
  atStart: boolean;
  atEnd: boolean;
  currentPage: number | null;
  totalPages: number | null;
}

function epubProgress(book: EpubBookInstance | null, loc: EpubLocation | null | undefined): EpubProgress {
  const totalPages = book ? book.locations.length() : 0;
  const progress: EpubProgress = {
    atStart: Boolean(loc?.atStart),
    atEnd: Boolean(loc?.atEnd),
    currentPage: null,
    totalPages: totalPages > 0 ? totalPages : null,
  };
  const cfi = loc?.start?.cfi;
  if (!book || !cfi || totalPages <= 0) return progress;
  const rawLocation = book.locations.locationFromCfi(cfi) as unknown;
  const locationIndex = typeof rawLocation === "number"
    ? rawLocation
    : Number(rawLocation);
  if (!Number.isFinite(locationIndex) || locationIndex < 0) return progress;
  const clamped = clampInt(locationIndex, 0, Math.max(0, totalPages - 1));
  progress.currentPage = clamped + 1;
  return progress;
}

export function EpubView({ url, name, downloadUrl, page, onScrolled }: {
  url: string;
  name: string;
  downloadUrl: string;
  page: number | null;
  onScrolled?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const bookRef = useRef<EpubBookInstance | null>(null);
  const renditionRef = useRef<EpubRenditionInstance | null>(null);
  const appliedLocatorRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(100);
  const [pageInput, setPageInput] = useState("");
  const [location, setLocation] = useState<EpubProgress>({
    atStart: true,
    atEnd: false,
    currentPage: null,
    totalPages: null,
  });

  const updateLocation = useCallback((loc: EpubLocation | null | undefined) => {
    const progress = epubProgress(bookRef.current, loc);
    setLocation(progress);
    if (document.activeElement !== pageInputRef.current) {
      setPageInput(progress.currentPage == null ? "" : String(progress.currentPage));
    }
  }, []);

  const goToPage = useCallback(async (rawPage: number) => {
    const book = bookRef.current;
    const rendition = renditionRef.current;
    const total = location.totalPages;
    if (!book || !rendition || !total) return;
    const targetPage = clampInt(rawPage, 1, total);
    const cfi = book.locations.cfiFromLocation(targetPage - 1) as unknown;
    if (typeof cfi !== "string" || !cfi || cfi === "-1") return;
    setPageInput(String(targetPage));
    await rendition.display(cfi);
    updateLocation(rendition.currentLocation() as unknown as EpubLocation | null);
  }, [location.totalPages, updateLocation]);

  const commitPageInput = useCallback(() => {
    const parsed = parseInt(pageInput, 10);
    if (!Number.isFinite(parsed)) {
      setPageInput(location.currentPage == null ? "" : String(location.currentPage));
      return;
    }
    void goToPage(parsed);
  }, [goToPage, location.currentPage, pageInput]);

  useEffect(() => {
    let cancelled = false;
    const markReady = () => {
      if (!cancelled) setReady(true);
    };
    setReady(false);
    setErr(null);
    setPageInput("");
    setLocation({
      atStart: true,
      atEnd: false,
      currentPage: null,
      totalPages: null,
    });
    const host = hostRef.current;
    host?.replaceChildren();

    (async () => {
      try {
        const { default: ePub } = await import("epubjs");
        if (cancelled || !hostRef.current) return;
        const book = ePub(url, { openAs: "epub" });
        const rendition = book.renderTo(hostRef.current, {
          width: "100%",
          height: "100%",
          spread: "none",
          flow: "paginated",
        });
        bookRef.current = book;
        renditionRef.current = rendition;
        rendition.themes.fontSize(`${fontSize}%`);
        rendition.on("rendered", markReady);
        rendition.on("displayed", markReady);
        rendition.on("relocated", (loc: EpubLocation) => {
          if (cancelled) return;
          markReady();
          updateLocation(loc);
        });
        await rendition.display();
        markReady();
        updateLocation(rendition.currentLocation() as unknown as EpubLocation | null);
        void book.ready.then(async () => {
          if (cancelled) return;
          (book.locations as unknown as { pause?: number }).pause = 0;
          await book.locations.generate(EPUB_LOCATION_CHARS);
          if (cancelled || renditionRef.current !== rendition) return;
          updateLocation(rendition.currentLocation() as unknown as EpubLocation | null);
        }).catch((error: unknown) => {
          if (!cancelled) setErr(error instanceof Error ? error.message : String(error));
        });
      } catch (error) {
        if (!cancelled) setErr(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
      try {
        renditionRef.current?.destroy();
      } catch {
        /* Best-effort cleanup for third-party viewer teardown. */
      }
      try {
        bookRef.current?.destroy();
      } catch {
        /* Best-effort cleanup for third-party viewer teardown. */
      }
      renditionRef.current = null;
      bookRef.current = null;
      hostRef.current?.replaceChildren();
    };
  }, [updateLocation, url]);

  useEffect(() => {
    if (!ready || !location.totalPages || page == null || page < 1) return;
    const key = `${url}:${page}:${location.totalPages}`;
    if (appliedLocatorRef.current === key) return;
    appliedLocatorRef.current = key;
    void goToPage(page).then(onScrolled);
  }, [goToPage, location.totalPages, onScrolled, page, ready, url]);

  useEffect(() => {
    renditionRef.current?.themes.fontSize(`${fontSize}%`);
  }, [fontSize]);

  useEffect(() => {
    const host = hostRef.current;
    const rendition = renditionRef.current;
    if (!host || !rendition) return;
    const resize = () => rendition.resize(host.clientWidth, host.clientHeight);
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(resize)
      : null;
    observer?.observe(host);
    window.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [ready]);

  const canZoomOut = ready && fontSize > EPUB_MIN_FONT;
  const canZoomIn = ready && fontSize < EPUB_MAX_FONT;
  const totalPages = location.totalPages ?? 0;
  const canJump = ready && totalPages > 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-subtle">
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-bg px-3 text-xs text-fg-muted">
        <div className="flex items-center gap-1">
          <ViewerToolbarButton
            title="Previous page"
            disabled={!ready || location.atStart}
            onClick={() => void renditionRef.current?.prev()}
          >
            <ChevronLeft size={14} />
          </ViewerToolbarButton>
          <input
            ref={pageInputRef}
            value={pageInput}
            disabled={!canJump}
            onChange={(event) => setPageInput(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={commitPageInput}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setPageInput(location.currentPage == null ? "" : String(location.currentPage));
                event.currentTarget.blur();
              }
            }}
            inputMode="numeric"
            className="h-7 w-12 rounded border border-border bg-bg px-1.5 text-center text-xs text-fg-base tabular-nums outline-none focus:border-accent disabled:opacity-50"
            aria-label="EPUB page"
          />
          <span className="min-w-10 text-center tabular-nums">/ {totalPages || "-"}</span>
          <ViewerToolbarButton
            title="Next page"
            disabled={!ready || location.atEnd}
            onClick={() => void renditionRef.current?.next()}
          >
            <ChevronRight size={14} />
          </ViewerToolbarButton>
        </div>
        <div className="h-5 w-px shrink-0 bg-border" />
        <div className="flex items-center gap-1">
          <ViewerToolbarButton
            title="Decrease text size"
            disabled={!canZoomOut}
            onClick={() => setFontSize((value) => clampInt(value - EPUB_FONT_STEP, EPUB_MIN_FONT, EPUB_MAX_FONT))}
          >
            <ZoomOut size={14} />
          </ViewerToolbarButton>
          <span className="min-w-14 text-center tabular-nums">{fontSize}%</span>
          <ViewerToolbarButton
            title="Increase text size"
            disabled={!canZoomIn}
            onClick={() => setFontSize((value) => clampInt(value + EPUB_FONT_STEP, EPUB_MIN_FONT, EPUB_MAX_FONT))}
          >
            <ZoomIn size={14} />
          </ViewerToolbarButton>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <a
            href={downloadUrl}
            download={name}
            title="Download"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border text-fg-muted transition-colors hover:bg-bg-muted"
          >
            <Download size={14} />
          </a>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-bg">
        <div ref={hostRef} className="h-full w-full" />
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
export function BinaryView({ url, name }: { url: string; name: string }) {
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
