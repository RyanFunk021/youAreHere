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
  let lockFailed = false;
  let fixes = 0;

  // While waiting, show elapsed time and the permission state, so a blocked
  // permission doesn't look the same as a slow fix.
  const t0 = Date.now();
  let perm = '';
  navigator.permissions?.query({ name: 'geolocation' }).then(p => { perm = p.state; p.onchange = () => { perm = p.state; }; }).catch(() => {});
  let lastErr = '';
  const waiting = setInterval(() => {
    if (fixes) return;
    status.textContent = `Waiting for GPS… ${Math.round((Date.now() - t0) / 1000)} s${perm ? ` · permission: ${perm}` : ''}${lastErr ? ` · ${lastErr}` : ''}`;
  }, 500);

  const watch = navigator.geolocation.watchPosition(pos => {
    const { latitude, longitude, accuracy } = pos.coords;
    fixes++;
    // Status first, so a failure in the map code below can't leave "Waiting…" on screen.
    status.textContent = `±${Math.round(accuracy)} m · ${trailLL.length} pts${lockFailed ? ' · screen may sleep' : ''}`;
    const ll: LatLng = [latitude, longitude];
    here = toMap(ll);
    acc.setLatLng(here).setRadius(accuracy / fit.metersPerPx).addTo(m);
    dot.setLatLng(here).addTo(m);
    if (accuracy <= MAX_TRAIL_ACCURACY_M) { trailLL.push(ll); trail.addLatLng(here); }
    if (fixes === 1) m.setView(here, Math.max(m.getZoom(), -1));
    else if (!m.getBounds().pad(-0.2).contains(here)) m.panTo(here); // follow when near the edge
  }, err => {
    // 1 = denied, 2 = unavailable, 3 = timeout (the watch keeps trying after a timeout).
    lastErr = err.code === 1
      ? 'Location blocked. iPhone Settings → Privacy & Security → Location Services: allow your browser (Safari Websites, or Apps → Chrome) While Using, then allow this site in the browser and reload.'
      : err.code === 2 ? 'Location unavailable: is Location Services on?'
      : 'no fix after 20 s, still trying (try outdoors)';
    if (!fixes || err.code !== 3) status.textContent = `GPS: ${lastErr}`;
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });

  root.querySelector('#recenter')!.addEventListener('click', () => { if (here) m.panTo(here); });

  // Keep the screen on (v1 is screen-on only; iOS stops GPS when locked).
  // A silent failure here looks like a GPS failure mid-ride, so say so in the status.
  let lock: WakeLockSentinel | undefined;
  const grab = async () => {
    try { await lock?.release(); lock = await navigator.wakeLock.request('screen'); lockFailed = false; }
    catch { lockFailed = true; status.textContent += ' · screen may sleep'; }
  };
  const onVis = () => { if (document.visibilityState === 'visible') grab(); };
  grab();
  document.addEventListener('visibilitychange', onVis);

  return () => {
    clearInterval(waiting);
    navigator.geolocation.clearWatch(watch);
    document.removeEventListener('visibilitychange', onVis);
    lock?.release();
    m.remove();
    URL.revokeObjectURL(url);
  };
}
