// How a calibrated map converts between photo pixels and lat/lng.
//
//   rigid    — one fit for the whole map (2 points: similarity; 3+: least-squares affine).
//              Right for surveyed maps: trailhead boards, park brochures, topos.
//   flexible — a thin-plate spline: passes exactly through every control point, bends as
//              little as possible in between, and relaxes to the rigid affine far away.
//              For painted / panoramic maps (ski maps) that no single fit can match.
//              Smooth everywhere, so the dot never jumps; no triangulation seams.
// Pure: no DOM, no Leaflet.
import { fitPoints, fromENU, llToPx, northOnPhotoDeg, pxToLL, solve, toENU, type ControlPoint, type LatLng, type Px } from './georef';

export type WarpMode = 'rigid' | 'flexible';

export interface Warp {
  mode: WarpMode;
  toPx(ll: LatLng): Px;
  toLL(px: Px): LatLng;
  metersPerPx: number;
  north: number;      // degrees clockwise from photo-up to true north (rigid estimate)
  folds: number[];    // control points nearest to where the warp turns inside out (flexible)
}

export const canFlex = (pts: ControlPoint[]) => pts.length >= 4;

export function makeWarp(pts: ControlPoint[], mode: WarpMode, w: number, h: number): Warp | null {
  const fit = fitPoints(pts);
  if (!fit) return null;
  const rigid: Warp = { mode: 'rigid', toPx: ll => llToPx(fit, ll), toLL: px => pxToLL(fit, px), metersPerPx: fit.metersPerPx, north: northOnPhotoDeg(fit), folds: [] };
  if (mode !== 'flexible' || !canFlex(pts)) return rigid;
  return spline(pts, rigid, fit.origin, w, h) ?? rigid;
}

type V2 = [number, number];
const U = (r2: number) => (r2 < 1e-12 ? 0 : r2 * Math.log(r2)); // TPS kernel, r² log r² (constant factor is irrelevant)

function spline(pts: ControlPoint[], rigid: Warp, o: LatLng, w: number, h: number): Warp | null {
  // Normalise pixels to ~[-1, 1] so the linear system is well-conditioned.
  const cx = w / 2, cy = h / 2, k = Math.max(w, h) / 2;
  const P: V2[] = pts.map(p => [(p.px[0] - cx) / k, (p.px[1] - cy) / k]);
  const E: V2[] = pts.map(p => toENU(p.ll, o));
  const n = P.length;
  // [K P; Pᵀ 0] [wts; a] = [targets; 0]
  const A: number[][] = Array.from({ length: n + 3 }, () => Array(n + 3).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = U((P[i][0] - P[j][0]) ** 2 + (P[i][1] - P[j][1]) ** 2);
    A[i][n] = A[n][i] = 1;
    A[i][n + 1] = A[n + 1][i] = P[i][0];
    A[i][n + 2] = A[n + 2][i] = P[i][1];
  }
  const cxs = solve(A, [...E.map(e => e[0]), 0, 0, 0]), cys = solve(A, [...E.map(e => e[1]), 0, 0, 0]);
  if (!cxs || !cys) return null;

  const fwd = (p: Px): V2 => {
    const u = (p[0] - cx) / k, v = (p[1] - cy) / k;
    let x = cxs[n] + cxs[n + 1] * u + cxs[n + 2] * v, y = cys[n] + cys[n + 1] * u + cys[n + 2] * v;
    for (let i = 0; i < n; i++) { const g = U((u - P[i][0]) ** 2 + (v - P[i][1]) ** 2); x += cxs[i] * g; y += cys[i] * g; }
    return [x, y];
  };
  // Jacobian d(ENU)/d(px) by central differences.
  const jac = (p: Px) => {
    const d = 0.5, a = fwd([p[0] + d, p[1]]), b = fwd([p[0] - d, p[1]]), c = fwd([p[0], p[1] + d]), e = fwd([p[0], p[1] - d]);
    return [(a[0] - b[0]) / (2 * d), (c[0] - e[0]) / (2 * d), (a[1] - b[1]) / (2 * d), (c[1] - e[1]) / (2 * d)];
  };
  // Inverse by Newton's method from the rigid estimate.
  const inv = (target: V2, start: Px): Px | null => {
    let p: Px = [start[0], start[1]];
    for (let it = 0; it < 30; it++) {
      const f = fwd(p), rx = target[0] - f[0], ry = target[1] - f[1];
      if (Math.hypot(rx, ry) < 1e-3) return p;
      const [j11, j12, j21, j22] = jac(p), det = j11 * j22 - j12 * j21;
      if (Math.abs(det) < 1e-12) return null;
      p = [p[0] + (j22 * rx - j12 * ry) / det, p[1] + (-j21 * rx + j11 * ry) / det];
    }
    return null;
  };

  // Folds: where the warp's orientation disagrees with the map's overall orientation
  // (photo v points down, north up, so a correct map has det(J) < 0 everywhere).
  const folds = new Set<number>();
  for (let gy = 0; gy <= 24; gy++) for (let gx = 0; gx <= 24; gx++) {
    const p: Px = [(gx / 24) * w, (gy / 24) * h], [j11, j12, j21, j22] = jac(p);
    if (j11 * j22 - j12 * j21 > 0) {
      let best = 0, bd = Infinity;
      pts.forEach((q, i) => { const dd = Math.hypot(q.px[0] - p[0], q.px[1] - p[1]); if (dd < bd) { bd = dd; best = i; } });
      folds.add(best);
    }
  }

  return {
    mode: 'flexible',
    toLL: p => fromENU(fwd(p), o),
    toPx: ll => inv(toENU(ll, o), rigid.toPx(ll)) ?? rigid.toPx(ll),
    metersPerPx: rigid.metersPerPx,
    north: rigid.north,
    folds: [...folds].sort((a, b) => a - b),
  };
}
