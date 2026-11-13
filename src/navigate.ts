import * as L from 'leaflet';
import { distM, fitAffine, llToPx, northOnPhotoDeg, pathM, type LatLng, type Pt } from './georef';
import { compassWidget } from './compass';
import { photoMap, pxToSimple } from './photo';
import { MAX_TRAIL_ACCURACY_M, MIN_TRAIL_STEP_M } from './config';
import { getSetting, loadTrail, saveTrail, setSetting, type Crumb, type SavedMap, type Trail } from './store';

const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);

export function showNavigate(root: HTMLElement, map: SavedMap) {
  root.innerHTML = `<div id="nav"></div><button id="recenter" class="fab">◎</button><div id="gps" class="status">Waiting for GPS…</div>`;
  const status = root.querySelector<HTMLElement>('#gps')!;
  const fit = fitAffine(map.points)!;
  const url = URL.createObjectURL(map.blob);
  const m = photoMap(root.querySelector<HTMLElement>('#nav')!, url, map.w, map.h);
  const toMap = (p: Pt) => pxToSimple(llToPx(fit, [p[0], p[1]]));

  // Breadcrumbs are saved per map as lat/lng (so recalibrating re-projects them).
  // Earlier rides load as their own segments; this session appends a new one.
  const style = { color: '#ff2d55', weight: 4, opacity: 0.85 };
  let past: Trail | null = null;      // null until loaded; never save before then
  let pastM = 0;
  const seg: Crumb[] = [];
  let segM = 0;
  let dirty = false;
  const pastLine = L.polyline([], style).addTo(m);
  const trail = L.polyline([], style).addTo(m);
  loadTrail(map.id).then(t => {
    past = t;
    pastM = t.reduce((sum, s) => sum + pathM(s), 0);
    pastLine.setLatLngs(t.map(s => s.map(toMap)));
  });
  const save = () => {
    if (!past || !dirty) return;
    dirty = false;
    saveTrail(map.id, seg.length > 1 ? [...past, seg] : past);
  };
  const autosave = setInterval(save, 5000);
  const onHide = () => { if (document.visibilityState === 'hidden') save(); };
  document.addEventListener('visibilitychange', onHide);
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

  // Location-blocked panel: a page can't force the browser's prompt back, but retrying
  // from a tap often re-prompts on iOS; if it fails again instantly, offer Reload + the setting.
  const fix = document.createElement('div');
  fix.className = 'locfix';
  fix.hidden = true;
  fix.innerHTML = `<div class="msg">Location is blocked for this page.</div>
    <button class="btn on" data-loc="ask">📍 Ask for location again</button>
    <div class="more" hidden>
      <div class="steps">Still blocked. iPhone Settings → Apps → Chrome → Location (Safari: Privacy &amp; Security → Location Services → Safari Websites) → <b>While Using the App</b> or <b>Ask Next Time</b>. Then reload and tap Allow.</div>
      <button class="btn" data-loc="reload">Reload page</button>
    </div>`;
  root.appendChild(fix);
  let asks = 0;
  fix.addEventListener('click', e => {
    const a = (e.target as HTMLElement).dataset.loc;
    if (a === 'reload') location.reload();
    if (a !== 'ask') return;
    asks++;
    lastErr = '';
    navigator.geolocation.clearWatch(watch);
    watch = startWatch(); // inside the tap, so the browser may show its prompt again
  });

  const startWatch = () => navigator.geolocation.watchPosition(pos => {
    fix.hidden = true;
    const { latitude, longitude, accuracy } = pos.coords;
    fixes++;
    // Status first, so a failure in the map code below can't leave "Waiting…" on screen.
    const ll: LatLng = [latitude, longitude];
    // Skip fixes that are too inaccurate, or too close to the last point (jitter while stopped).
    if (accuracy <= MAX_TRAIL_ACCURACY_M) {
      const last = seg[seg.length - 1];
      const step = last ? distM(last, ll) : 0;
      if (!last || step >= MIN_TRAIL_STEP_M) { seg.push([latitude, longitude, Date.now()]); segM += step; dirty = true; trail.addLatLng(toMap(ll)); }
    }
    status.textContent = `±${Math.round(accuracy)} m · this ride ${km(segM)} · total ${km(pastM + segM)}${lockFailed ? ' · screen may sleep' : ''}`;
    here = toMap(ll);
    acc.setLatLng(here).setRadius(accuracy / fit.metersPerPx).addTo(m);
    dot.setLatLng(here).addTo(m);
    if (fixes === 1) m.setView(here, Math.max(m.getZoom(), -1));
    else if (!m.getBounds().pad(-0.2).contains(here)) m.panTo(here); // follow when near the edge
  }, err => {
    // 1 = denied, 2 = unavailable, 3 = timeout (the watch keeps trying after a timeout).
    lastErr = err.code === 1
      ? 'location blocked'
      : err.code === 2 ? 'Location unavailable: is Location Services on?'
      : 'no fix after 20 s, still trying (try outdoors)';
    if (!fixes || err.code !== 3) status.textContent = `GPS: ${lastErr}`;
    if (err.code === 1) {
      fix.hidden = false;
      (fix.querySelector('.more') as HTMLElement).hidden = asks === 0;
    }
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  let watch = startWatch();

  root.querySelector('#recenter')!.addEventListener('click', () => { if (here) m.panTo(here); });
  const removeCompass = compassWidget(root, northOnPhotoDeg(fit));

  // Screen: kept on by default. Battery saver lets it sleep; a web page gets no GPS
  // while the screen is off, so breadcrumbs are then recorded whenever you look at the
  // map, and joined with straight lines across the gaps.
  // A silent wake-lock failure looks like a GPS failure mid-ride, so say so in the status.
  let lock: WakeLockSentinel | undefined;
  let saver = false;
  const grab = async () => {
    if (saver) return;
    try { await lock?.release(); lock = await navigator.wakeLock.request('screen'); lockFailed = false; }
    catch { lockFailed = true; status.textContent += ' · screen may sleep'; }
  };
  const onVis = () => { if (document.visibilityState === 'visible') grab(); };
  document.addEventListener('visibilitychange', onVis);

  const power = document.createElement('button');
  power.className = 'power';
  root.appendChild(power);
  const showPower = () => { power.textContent = saver ? '🔋 Battery saver' : '🔆 Screen stays on'; power.classList.toggle('on', saver); };
  getSetting<boolean>('batterySaver').then(v => { saver = !!v; showPower(); if (!saver) grab(); });
  power.addEventListener('click', async () => {
    saver = !saver;
    setSetting('batterySaver', saver);
    showPower();
    if (saver) { await lock?.release(); lock = undefined; lockFailed = false; }
    else grab();
    status.textContent = saver
      ? 'Battery saver: screen can sleep. Breadcrumbs record whenever you look at the map.'
      : 'Screen stays on. Breadcrumbs record continuously.';
  });

  return () => {
    removeCompass();
    fix.remove();
    power.remove();
    save();
    clearInterval(autosave);
    document.removeEventListener('visibilitychange', onHide);
    clearInterval(waiting);
    navigator.geolocation.clearWatch(watch);
    document.removeEventListener('visibilitychange', onVis);
    lock?.release();
    m.remove();
    URL.revokeObjectURL(url);
  };
}
