import * as L from 'leaflet';
import { fitAffine, llToPx, type LatLng } from './georef';
import { photoMap, pxToSimple } from './photo';
import { MAX_TRAIL_ACCURACY_M } from './config';
import type { SavedMap } from './store';

// Session breadcrumbs, kept as lat/lng so a recalibration re-projects them.
const trailLL: LatLng[] = [];

export function showNavigate(root: HTMLElement, map: SavedMap) {
  root.innerHTML = `<div id="nav"></div><button id="recenter" class="fab">◎</button><div id="gps" class="status">Waiting for GPS…</div>`;
  const status = root.querySelector<HTMLElement>('#gps')!;
  const fit = fitAffine(map.points)!;
  const url = URL.createObjectURL(map.blob);
  const m = photoMap(root.querySelector<HTMLElement>('#nav')!, url, map.w, map.h);
  const toMap = (ll: LatLng) => pxToSimple(llToPx(fit, ll));

  const trail = L.polyline(trailLL.map(toMap), { color: '#ff2d55', weight: 4, opacity: 0.85 }).addTo(m);
  const acc = L.circle([0, 0], { radius: 1, color: '#007aff', weight: 1, fillOpacity: 0.12, interactive: false });
  const dot = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 3, fillColor: '#007aff', fillOpacity: 1, interactive: false });
  let here: L.LatLng | null = null;

  const watch = navigator.geolocation.watchPosition(pos => {
    const { latitude, longitude, accuracy } = pos.coords;
    const ll: LatLng = [latitude, longitude];
    here = toMap(ll);
    acc.setLatLng(here).setRadius(accuracy / fit.metersPerPx).addTo(m);
    dot.setLatLng(here).addTo(m);
    if (accuracy <= MAX_TRAIL_ACCURACY_M) { trailLL.push(ll); trail.addLatLng(here); }
    if (trailLL.length <= 1) m.setView(here, Math.max(m.getZoom(), -1));
    status.textContent = `±${Math.round(accuracy)} m · ${trailLL.length} pts`;
  }, err => { status.textContent = `GPS: ${err.message}`; }, { enableHighAccuracy: true, maximumAge: 0 });

  root.querySelector('#recenter')!.addEventListener('click', () => { if (here) m.panTo(here); });

  // Keep the screen on (v1 is screen-on only; iOS stops GPS when locked).
  let lock: WakeLockSentinel | undefined;
  const grab = async () => { lock = await navigator.wakeLock?.request('screen'); };
  const onVis = () => { if (document.visibilityState === 'visible') grab(); };
  grab();
  document.addEventListener('visibilitychange', onVis);

  return () => {
    navigator.geolocation.clearWatch(watch);
    document.removeEventListener('visibilitychange', onVis);
    lock?.release();
    m.remove();
    URL.revokeObjectURL(url);
  };
}
