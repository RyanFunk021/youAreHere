// The demo map: USGS 1:62,500 Peoria, IL quadrangle, surveyed 1902–04, edition of 1905
// (reprinted 1940), from the USGS Historical Topographic Map Collection. Public domain.
// Calibrated exactly: its four neatline corners are printed at 40°30'/40°45' N and
// 89°30'/89°45' W. Pixel positions were measured by fitting a line to each neatline edge;
// the top edge is 0.37% narrower than the bottom (meridian convergence), as it should be.
import type { ControlPoint } from './georef';
import { loadMap, saveMap, type SavedMap } from './store';

export const DEMO_ID = 'demo-peoria-1905';
const NAME = 'Demo: Peoria, IL in 1905 (USGS topo)';
const URL_ = 'demo/peoria-1905.jpg';
const POINTS: ControlPoint[] = [
  { px: [280.1, 171.5], ll: [40.75, -89.75] },
  { px: [2709.5, 171.5], ll: [40.75, -89.5] },
  { px: [275.3, 3365.5], ll: [40.5, -89.75] },
  { px: [2713.8, 3365.5], ll: [40.5, -89.5] },
];

export async function loadDemo(): Promise<SavedMap> {
  const existing = await loadMap(DEMO_ID);
  if (existing) return existing;
  const r = await fetch(URL_);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  const map: SavedMap = { id: DEMO_ID, name: NAME, blob, w: img.naturalWidth, h: img.naturalHeight, points: POINTS };
  URL.revokeObjectURL(img.src);
  await saveMap(map);
  return map;
}
