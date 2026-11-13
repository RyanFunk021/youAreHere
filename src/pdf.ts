// Rasterize one PDF page to a JPEG so the rest of the app treats it like a photo.
// pdf.js is loaded on demand: it's large, and only PDF imports need it.

// iOS Safari caps canvases at ~16.7M pixels; stay under it and at 4096 px a side.
const MAX_SIDE = 4096;
const MAX_AREA = 16_000_000;

export async function pdfToImage(file: File, onStatus: (s: string) => void): Promise<Blob> {
  onStatus('Opening PDF…');
  // Legacy build: transpiled for older Safari, which the friend's iPhone may run.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { default: workerUrl } = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  let n = 1;
  if (doc.numPages > 1) {
    const ans = prompt(`This PDF has ${doc.numPages} pages. Which page is the map?`, '1');
    n = Math.min(Math.max(parseInt(ans ?? '1', 10) || 1, 1), doc.numPages);
  }

  onStatus(`Rendering page ${n}…`);
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(MAX_SIDE / Math.max(base.width, base.height), Math.sqrt(MAX_AREA / (base.width * base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;

  const blob = await new Promise<Blob>(r => canvas.toBlob(b => r(b!), 'image/jpeg', 0.9));
  canvas.width = canvas.height = 0; // release the bitmap now; iOS is stingy with canvas memory
  await task.destroy(); // v6: destroy() lives on the loading task, not the document
  return blob;
}
