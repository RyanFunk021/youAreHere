// Pure georeferencing math. No DOM, no Leaflet — portable to native later.
//
// Photo pixels (u right, v down) <-> local east/north meters (ENU tangent plane
// centred on the control points) <-> WGS84 lat/lng.
//
// Control points are the source of truth; a Fit is always derived from them.

export type LatLng = [number, number];
export type Px = [number, number];
export interface ControlPoint { px: Px; ll: LatLng }

export interface Fit {
  origin: LatLng;
  // x = m[0]*u + m[1]*v + m[2]   (east, meters)
  // y = m[3]*u + m[4]*v + m[5]   (north, meters)
  m: number[];
  metersPerPx: number;
}

const R = 6378137;
const D2R = Math.PI / 180;

// Local plane around origin o. East uses each point's own latitude (a sinusoidal
// projection), so meridians converge as on a real map: a 15' USGS sheet's top edge is
// 0.37% narrower than its bottom. A single cos(lat0) would mis-place the corners of
// large maps by ~20 m; for small trail maps the two are identical.
export function toENU(ll: LatLng, o: LatLng): [number, number] {
  return [(ll[1] - o[1]) * D2R * R * Math.cos(ll[0] * D2R), (ll[0] - o[0]) * D2R * R];
}

export function fromENU(xy: [number, number], o: LatLng): LatLng {
  const lat = o[0] + xy[1] / (R * D2R);
  return [lat, o[1] + xy[0] / (R * D2R * Math.cos(lat * D2R))];
}

// Great-circle distance in meters (haversine).
// Anything with lat at [0] and lng at [1]: a LatLng or a breadcrumb [lat, lng, time?].
export type Pt = { readonly 0: number; readonly 1: number };

export function distM(a: Pt, b: Pt): number {
  const dLat = (b[0] - a[0]) * D2R, dLng = (b[1] - a[1]) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const pathM = (p: readonly Pt[]) => p.reduce((s, x, i) => (i ? s + distM(p[i - 1], x) : 0), 0);

function centroid(pts: ControlPoint[]): LatLng {
  const n = pts.length;
  return [pts.reduce((s, p) => s + p.ll[0], 0) / n, pts.reduce((s, p) => s + p.ll[1], 0) / n];
}

// Gaussian elimination with partial pivoting, n x n.
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Least-squares affine, photo px -> ENU meters. Needs 3+ non-collinear points.
// Pixels are centred/scaled before solving so the normal matrix stays well-conditioned.
export function fitAffine(pts: ControlPoint[], origin: LatLng = centroid(pts)): Fit | null {
  if (pts.length < 3) return null;
  const n = pts.length;
  const cu = pts.reduce((s, p) => s + p.px[0], 0) / n;
  const cv = pts.reduce((s, p) => s + p.px[1], 0) / n;
  const k = Math.max(...pts.map(p => Math.hypot(p.px[0] - cu, p.px[1] - cv))) || 1;

  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const bx = [0, 0, 0], by = [0, 0, 0];
  for (const p of pts) {
    const r = [(p.px[0] - cu) / k, (p.px[1] - cv) / k, 1];
    const [x, y] = toENU(p.ll, origin);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) S[i][j] += r[i] * r[j];
      bx[i] += r[i] * x;
      by[i] += r[i] * y;
    }
  }
  const a = solve(S, bx), b = solve(S, by);
  if (!a || !b) return null;

  // Un-normalise: x = a0*(u-cu)/k + a1*(v-cv)/k + a2
  const m = [
    a[0] / k, a[1] / k, a[2] - (a[0] * cu + a[1] * cv) / k,
    b[0] / k, b[1] / k, b[2] - (b[0] * cu + b[1] * cv) / k,
  ];
  const det = m[0] * m[4] - m[1] * m[3];
  if (Math.abs(det) < 1e-12) return null;
  return { origin, m, metersPerPx: Math.sqrt(Math.abs(det)) };
}

// Exact 2-point fit: rotation + uniform scale + translation (a "similarity"). Photo v
// points down while north points up, so with w = -v:  x = a·u + b·v + tx,  y = b·u - a·v + ty.
// Two points give no error signal (any 2 points fit exactly); 3+ points use fitAffine.
export function fitSimilarity2(pts: ControlPoint[], origin: LatLng = centroid(pts)): Fit | null {
  if (pts.length !== 2) return null;
  const [p1, p2] = pts;
  const [x1, y1] = toENU(p1.ll, origin), [x2, y2] = toENU(p2.ll, origin);
  const du = p2.px[0] - p1.px[0], dv = p2.px[1] - p1.px[1], dx = x2 - x1, dy = y2 - y1;
  const q = du * du + dv * dv;
  if (q < 1e-9) return null; // same pixel twice
  const a = (dx * du - dy * dv) / q, b = (dx * dv + dy * du) / q;
  const m = [a, b, x1 - a * p1.px[0] - b * p1.px[1], b, -a, y1 - b * p1.px[0] + a * p1.px[1]];
  return { origin, m, metersPerPx: Math.hypot(a, b) };
}

// The fit used everywhere: 2 points → similarity, 3+ → least-squares affine.
export const fitPoints = (pts: ControlPoint[], origin?: LatLng) =>
  pts.length === 2 ? fitSimilarity2(pts, origin) : fitAffine(pts, origin);

export function pxToENU(f: Fit, px: Px): [number, number] {
  const m = f.m;
  return [m[0] * px[0] + m[1] * px[1] + m[2], m[3] * px[0] + m[4] * px[1] + m[5]];
}

export function pxToLL(f: Fit, px: Px): LatLng {
  return fromENU(pxToENU(f, px), f.origin);
}

export function llToPx(f: Fit, ll: LatLng): Px {
  const m = f.m;
  const [x, y] = toENU(ll, f.origin);
  const det = m[0] * m[4] - m[1] * m[3];
  const dx = x - m[2], dy = y - m[5];
  return [(m[4] * dx - m[1] * dy) / det, (-m[3] * dx + m[0] * dy) / det];
}

// Direction of true north on the photo, in degrees clockwise from the photo's "up".
// Inverse of the fit's linear part applied to one meter north: (du, dv) = (-m1, m0) / det.
export function northOnPhotoDeg(f: Fit): number {
  const [a, b, , d, e] = f.m;
  const det = a * e - b * d;
  const du = -b / det, dv = a / det;
  return ((Math.atan2(du, -dv) * 180) / Math.PI + 360) % 360; // screen "up" is -v
}

// In-sample residual per point, ground meters. With exactly 3 points an affine fit
// is exact (all zeros), so residuals only mean anything from 4 points.
export function residuals(pts: ControlPoint[], f = fitAffine(pts)): number[] | null {
  if (!f || pts.length < 4) return null;
  return pts.map(p => {
    const [px, py] = pxToENU(f, p.px);
    const [x, y] = toENU(p.ll, f.origin);
    return Math.hypot(px - x, py - y);
  });
}

export function rms(pts: ControlPoint[]): number | null {
  const r = residuals(pts);
  return r && Math.sqrt(r.reduce((s, e) => s + e * e, 0) / r.length);
}

// Which point is most likely mis-tapped: the one whose removal improves the fit most.
// Simulated on 5 random points with one 30 m mis-tap, this finds the culprit ~94% of
// the time, versus ~54% for "largest residual" and ~20% for leave-one-out
// prediction error (a far corner predicted from the others is extrapolation, so LOO
// blames corners). Needs 5+ points so the remaining fit still has residuals.
export function suspect(pts: ControlPoint[]): { index: number; rmsWithout: number } | null {
  if (pts.length < 5) return null;
  let best: { index: number; rmsWithout: number } | null = null;
  pts.forEach((_, i) => {
    const e = rms(pts.filter((_, j) => j !== i));
    if (e !== null && (!best || e < best.rmsWithout)) best = { index: i, rmsWithout: e };
  });
  return best;
}
