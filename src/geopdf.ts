// Zero-tap calibration: read the georeferencing a GeoPDF already carries.
//
// Two encodings are in the wild:
//   • OGC / TerraGo "LGIDict" in the page dictionary (USGS historical topos, many
//     Avenza-store maps): a CTM from PDF space to projected metres, a Projection dict
//     (polyconic, UTM, Lambert…, with a datum), and a Neatline polygon.
//   • ISO 32000-2 "/VP" viewports with a /Measure /Subtype /GEO dict (US Topo and newer
//     GeoPDFs): GPTS (lat/lon pairs) at LPTS positions within the viewport's BBox.
// Either way we return points in PDF user space with their lat/lng; pdf.ts turns the PDF
// points into pixels with the same viewport it rendered with.
import type { LatLng } from './georef';

export interface GeoReg { source: 'LGIDict' | 'ISO-GEO'; pdfPts: [number, number][]; ll: LatLng[] }

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const nums = (s: string) => (s.match(NUM) ?? []).map(Number);

// Text of the balanced <<…>> or […] that starts at s[i].
function balanced(s: string, i: number): string {
  let depth = 0;
  for (let j = i; j < s.length && j < i + 200_000; j++) {
    const two = s.substr(j, 2);
    if (two === '<<') { depth++; j++; } else if (two === '>>') { depth--; j++; if (!depth) return s.slice(i, j + 1); }
    else if (s[j] === '[') depth++;
    else if (s[j] === ']') { depth--; if (!depth) return s.slice(i, j + 1); }
    else if (s[j] === '(') { const k = s.indexOf(')', j); if (k > 0) j = k; } // skip PDF strings
  }
  return '';
}
// Value following /Key: a balanced dict/array, a (string), or a bare token.
function value(block: string, key: string): string | null {
  const m = new RegExp(`/${key}(?![A-Za-z])\\s*`).exec(block);
  if (!m) return null;
  const i = m.index + m[0].length;
  if (block.startsWith('<<', i) || block[i] === '[') return balanced(block, i);
  if (block[i] === '(') return block.slice(i + 1, block.indexOf(')', i));
  return block.slice(i).match(/^[^\s/<>[\]()]+/)?.[0] ?? null;
}

// ---- LGIDict ------------------------------------------------------------------------
const DATUM: [RegExp, string][] = [
  [/^NAS/i, '+ellps=clrk66 +towgs84=-8,160,176'],   // NAD27 (CONUS mean shift, ~5–10 m)
  [/^NAR/i, '+ellps=GRS80 +towgs84=0,0,0'],         // NAD83
  [/^WG[ES]/i, '+datum=WGS84'],
];
function projString(p: string): string | null {
  const g = (k: string, d = '0') => value(p, k) ?? d;
  const datum = DATUM.find(([re]) => re.test(g('Datum', 'WGE')))?.[1] ?? '+datum=WGS84';
  const units = /^f/i.test(g('Units', 'm')) ? '+units=us-ft' : '+units=m';
  const base = `+lat_0=${g('OriginLatitude')} +lon_0=${g('CentralMeridian')} +x_0=${g('FalseEasting')} +y_0=${g('FalseNorthing')}`;
  const t = g('ProjectionType', '').toUpperCase();
  const proj =
    t === 'UT' ? `+proj=utm +zone=${g('Zone')}${/^S/i.test(g('Hemisphere', 'N')) ? ' +south' : ''}`
    : t === 'TC' ? `+proj=tmerc ${base} +k=${g('ScaleFactor', '1')}`
    : t === 'PH' ? `+proj=poly ${base}`
    : t === 'LE' ? `+proj=lcc +lat_1=${g('StandardParallelOne')} +lat_2=${g('StandardParallelTwo')} ${base}`
    : t === 'AC' ? `+proj=aea +lat_1=${g('StandardParallelOne')} +lat_2=${g('StandardParallelTwo')} ${base}`
    : t === 'MC' ? `+proj=merc +lon_0=${g('CentralMeridian')} +k=${g('ScaleFactor', '1')} +x_0=${g('FalseEasting')} +y_0=${g('FalseNorthing')}`
    : /^GEO/.test(t) ? '+proj=longlat'
    : null;
  return proj && `${proj} ${datum} ${units} +no_defs`;
}

async function fromLGI(text: string, pageIndex: number): Promise<GeoReg | null> {
  const hits = [...text.matchAll(/\/LGIDict\s*/g)];
  if (!hits.length) return null;
  const h = hits[Math.min(pageIndex, hits.length - 1)];
  let block = balanced(text, h.index! + h[0].length);
  if (block.startsWith('[')) block = balanced(block, block.indexOf('<<')); // array of dicts: take the first
  const projDict = /\/Projection\s*<</.exec(block);
  const proj = projString(projDict ? balanced(block, projDict.index + projDict[0].length - 2) : (value(block, 'Display') ?? ''));
  if (!proj) return null;

  const ctm = nums(value(block, 'CTM') ?? '');
  const reg = nums(value(block, 'Registration') ?? '');
  const neat = nums(value(block, 'Neatline') ?? '');
  let pdfPts: [number, number][], xy: [number, number][];
  if (ctm.length === 6) {
    const [a, b, c, d, e, f] = ctm;
    pdfPts = neat.length >= 6 ? pairs(neat) : pairs(reg).filter((_, i) => i % 2 === 0);
    pdfPts = thin(dedupe(pdfPts), 16);
    pdfPts.push(centroid(pdfPts));
    xy = pdfPts.map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  } else if (reg.length >= 8) {
    const quads = Array.from({ length: Math.floor(reg.length / 4) }, (_, i) => reg.slice(i * 4, i * 4 + 4));
    pdfPts = quads.map(q => [q[0], q[1]]);
    xy = quads.map(q => [q[2], q[3]]);
  } else return null;

  const { default: proj4 } = await import('proj4');
  const ll = xy.map(p => { const [lon, lat] = proj4(proj, 'EPSG:4326', p); return [lat, lon] as LatLng; });
  return ll.every(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180)
    ? { source: 'LGIDict', pdfPts, ll } : null;
}

// ---- ISO 32000 /VP + /Measure /GEO -----------------------------------------------
function fromISO(text: string, pageIndex: number): GeoReg | null {
  const vps = [...text.matchAll(/\/VP\s*\[/g)];
  if (!vps.length) return null;
  const vp = vps[Math.min(pageIndex, vps.length - 1)];
  const arr = balanced(text, vp.index! + vp[0].length - 1);
  let best: GeoReg | null = null, bestArea = 0;
  for (let i = arr.indexOf('<<'); i >= 0; i = arr.indexOf('<<', i + 2)) {
    const d = balanced(arr, i);
    if (!d) break;
    const bbox = nums(value(d, 'BBox') ?? ''), measure = value(d, 'Measure') ?? '';
    const gpts = nums(value(measure, 'GPTS') ?? ''), lpts = nums(value(measure, 'LPTS') ?? '');
    if (bbox.length === 4 && /\/Subtype\s*\/GEO/.test(measure) && gpts.length >= 6 && lpts.length === gpts.length) {
      const [x0, y0, x1, y1] = bbox, area = Math.abs((x1 - x0) * (y1 - y0));
      if (area > bestArea) {
        bestArea = area;
        best = { source: 'ISO-GEO', pdfPts: pairs(lpts).map(([u, v]) => [x0 + u * (x1 - x0), y0 + v * (y1 - y0)]), ll: pairs(gpts).map(([la, lo]) => [la, lo]) };
      }
    }
    i += d.length - 2;
  }
  return best;
}

// ---- helpers ---------------------------------------------------------------------
function pairs(a: number[]): [number, number][] { const r: [number, number][] = []; for (let i = 0; i + 1 < a.length; i += 2) r.push([a[i], a[i + 1]]); return r; }
const dedupe = (p: [number, number][]) => p.filter((q, i) => p.findIndex(r => Math.hypot(r[0] - q[0], r[1] - q[1]) < 1) === i);
const thin = (p: [number, number][], max: number) => p.length <= max ? p : Array.from({ length: max }, (_, i) => p[Math.floor(i * p.length / max)]);
const centroid = (p: [number, number][]): [number, number] => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];

// Page dictionaries are often inside compressed object streams; inflate those too.
async function objectStreams(bytes: Uint8Array, text: string): Promise<string[]> {
  const out: string[] = [];
  for (const m of text.matchAll(/<<([^]{0,300}?\/Type\s*\/ObjStm[^]{0,300}?)>>\s*stream\r?\n/g)) {
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(m[1]);
    if (!len || !/FlateDecode/.test(m[1])) continue;
    const start = m.index! + m[0].length, data = bytes.slice(start, start + +len[1]);
    try { out.push(await inflateCapped(data, 10_000_000)); }
    catch { /* not a deflate stream we can read; skip */ }
    if (out.length > 200) break;
  }
  return out;
}

// Inflate, but stop at `cap` bytes: a hostile PDF could hold a "decompression bomb".
async function inflateCapped(data: Uint8Array, cap: number): Promise<string> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    total += chunk.length;
    if (total > cap) { await reader.cancel(); break; }
    parts.push(chunk);
  }
  return new TextDecoder('latin1').decode(await new Blob(parts as BlobPart[]).arrayBuffer());
}

export async function findGeoReg(bytes: Uint8Array, pageIndex: number): Promise<GeoReg | null> {
  const text = new TextDecoder('latin1').decode(bytes);
  const texts = /\/LGIDict|\/GPTS/.test(text) ? [text] : await objectStreams(bytes, text);
  for (const t of texts) {
    const r = (await fromLGI(t, pageIndex)) ?? fromISO(t, pageIndex);
    if (r && r.pdfPts.length >= 2) return r;
  }
  return null;
}
