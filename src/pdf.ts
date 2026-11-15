// Rasterize one PDF page to a JPEG so the rest of the app treats it like a photo.
// If the PDF carries its own georeferencing (a GeoPDF), also return control points so
// the map needs no calibration taps.
import type { ControlPoint } from './georef';
import { findGeoReg } from './geopdf';
// pdf.js is loaded on demand: it's large, and only PDF imports need it.

// iOS Safari caps canvases at ~16.7M pixels; stay under it and at 4096 px a side.
const MAX_SIDE = 4096;
const MAX_AREA = 16_000_000;

// Legacy build: transpiled for older Safari, which the friend's iPhone may run.
let lib: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;
function loadLib() {
  lib ??= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return lib;
}

// Called when the picker opens, so the download overlaps the user choosing a file.
export function preloadPdf() { loadLib(); }

export async function pdfToImage(file: File, stage: (s: string) => void): Promise<{ blob: Blob; points: ControlPoint[]; geoSource?: string }> {
  stage('Loading PDF reader');
  const pdfjs = await loadLib();

  stage(`Opening PDF (${(file.size / 1e6).toFixed(1)} MB)`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const copy = bytes.slice(); // pdf.js may take ownership of (detach) the buffer it's given
  const task = pdfjs.getDocument({ data: bytes });
  const doc = await task.promise;
  let n = 1;
  if (doc.numPages > 1) {
    stage('Waiting for page choice');
    const ans = prompt(`This PDF has ${doc.numPages} pages. Which page is the map?`, '1');
    n = Math.min(Math.max(parseInt(ans ?? '1', 10) || 1, 1), doc.numPages);
  }

  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(MAX_SIDE / Math.max(base.width, base.height), Math.sqrt(MAX_AREA / (base.width * base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  stage(`Drawing page ${n} at ${canvas.width}×${canvas.height}`);
  await page.render({ canvas, viewport }).promise;

  stage('Compressing');
  const blob = await new Promise<Blob>(r => canvas.toBlob(b => r(b!), 'image/jpeg', 0.9));
  canvas.width = canvas.height = 0; // release the bitmap now; iOS is stingy with canvas memory

  stage('Looking for built-in coordinates');
  const geo = await findGeoReg(copy, n - 1).catch(() => null);
  const points: ControlPoint[] = geo
    ? geo.pdfPts.map((p, i) => ({ px: viewport.convertToViewportPoint(p[0], p[1]) as [number, number], ll: geo.ll[i] }))
    : [];
  await task.destroy(); // v6: destroy() lives on the loading task, not the document
  return { blob, points, geoSource: geo?.source };
}
