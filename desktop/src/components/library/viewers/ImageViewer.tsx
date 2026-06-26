import { useEffect, useMemo, useRef, useState } from "react";

import {
  ViewerError,
  ViewerLoading,
  applyVisualPageScale,
  refreshVisualPageBase,
  useViewportWheelZoom,
} from "./ViewerShared";
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
