import { useRef } from "react";
export function PdfView({ url, page }: { url: string; page: number | null }) {
  // The PDF Open Parameters spec lets us append `#page=N` to scroll the
  // browser viewer to a 1-indexed page. Works in Chrome, Firefox, and
  // Edge's built-in viewers 鈥?Safari historically ignores it but degrades
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
