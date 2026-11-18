import * as L from 'leaflet';
import { fitPoints, residuals, rms, suspect, type LatLng, type Px } from './georef';
import { canFlex, makeWarp } from './warp';
import { photoMap, pin, pxToSimple, simpleToPx } from './photo';
import { HOME, HOME_ZOOM, SATELLITE, STREETS } from './config';
import type { SavedMap } from './store';

// Tap a spot on the photo, then the same spot on the satellite -> one control pair.
export function showCalibrate(root: HTMLElement, map: SavedMap, save: () => void, onPointsChanged: () => void) {
  root.innerHTML = `<div class="cal"><div id="ph"></div><div id="bar"></div><div id="sat"></div></div>`;
  const bar = root.querySelector<HTMLElement>('#bar')!;
  const url = URL.createObjectURL(map.blob);
  const ph = photoMap(root.querySelector<HTMLElement>('#ph')!, url, map.w, map.h);

  const sat = L.map(root.querySelector<HTMLElement>('#sat')!, { zoomControl: false, maxZoom: 21 });
  const imagery = L.tileLayer(SATELLITE.url, { attribution: SATELLITE.attribution, maxNativeZoom: 19, maxZoom: 21 }).addTo(sat);
  const streets = L.tileLayer(STREETS.url, { attribution: STREETS.attribution, maxNativeZoom: 19, maxZoom: 21 });
  const streetsOver = L.tileLayer(STREETS.url, { attribution: STREETS.attribution, maxNativeZoom: 19, maxZoom: 21, opacity: 0.45 });
  L.control.layers({ Satellite: imagery, Map: streets }, { 'Map overlay': streetsOver }, { position: 'topright' }).addTo(sat);

  if (map.points.length) sat.fitBounds(L.latLngBounds(map.points.map(p => p.ll)), { padding: [30, 30], maxZoom: 17 });
  else sat.setView(HOME, HOME_ZOOM);

  // Your location on the satellite view. Calibration usually happens at the trailhead,
  // so with no pairs yet the satellite jumps to you (unless you've started panning), and
  // the first tap on the map zooms it in on you. ◎ jumps back any time.
  // (Ryan's hike: a one-shot request with no timeout could wait forever on iPhone.)
  let me: LatLng | null = null, locErr = '', satTouched = false;
  const meDot = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 3, fillColor: '#007aff', fillOpacity: 1, interactive: false });
  const satEl = root.querySelector<HTMLElement>('#sat')!;
  for (const ev of ['pointerdown', 'touchstart', 'wheel']) satEl.addEventListener(ev, () => { satTouched = true; }, { passive: true });
  const goToMe = () => { if (me) sat.setView(me, Math.max(sat.getZoom(), 17)); };
  const watch = navigator.geolocation.watchPosition(p => {
    const first = !me;
    me = [p.coords.latitude, p.coords.longitude];
    locErr = '';
    meDot.setLatLng(me).addTo(sat);
    if (first && !map.points.length && !satTouched) goToMe();
    if (first) draw();
  }, e => { locErr = e.code === 1 ? 'location is blocked' : 'your location isn’t available yet'; if (!me) draw(); },
  { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 });
  const LocateControl = L.Control.extend({ onAdd: () => {
    const b = L.DomUtil.create('button', 'sat-locate');
    b.textContent = '◎'; b.title = 'Go to my location';
    L.DomEvent.disableClickPropagation(b);
    b.addEventListener('click', () => { satTouched = true; if (me) goToMe(); else draw(); });
    return b;
  } });
  new LocateControl({ position: 'bottomright' }).addTo(sat);

  // The bar between the maps changes height (hint wraps, Cancel/Add replaces the chips),
  // which resizes both panels. Leaflet must be told, or its centre goes stale: the
  // jump-to-prediction lands off-centre and tiles leave grey gaps. pan keeps the centre.
  const ro = new ResizeObserver(() => { ph.invalidateSize({ pan: true }); sat.invalidateSize({ pan: true }); });
  ro.observe(root.querySelector('#ph')!);
  ro.observe(root.querySelector('#sat')!);

  const phLayer = L.layerGroup().addTo(ph);
  const satLayer = L.layerGroup().addTo(sat);
  // A tap only places a pending point; re-tap to adjust. "Add pair" commits.
  // (A fingertip covers the target, and closing the layers menu is also a map click.)
  let pendingPx: Px | null = null;
  let pendingLL: LatLng | null = null;

  ph.on('click', e => {
    pendingPx = simpleToPx(e.latlng);
    // Once a fit exists, jump the satellite to where it predicts this pixel is.
    const f = makeWarp(map.points, map.warp ?? 'rigid', map.w, map.h);
    if (f && !pendingLL) sat.panTo(f.toLL(pendingPx));
    else if (!f && !pendingLL && !map.points.length) goToMe(); // first pair: start where you're standing
    draw();
  });

  sat.on('click', e => {
    if (!pendingPx) return;
    pendingLL = [e.latlng.lat, e.latlng.lng];
    draw();
  });

  bar.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    if (t.dataset.mode) { map.warp = t.dataset.mode as 'rigid' | 'flexible'; save(); draw(); return; }
    if (t.id === 'add' && pendingPx && pendingLL) {
      map.points.push({ px: pendingPx, ll: pendingLL });
    } else if (t.id === 'cancel') {
      // just clear pending below
    } else if (t.dataset.del !== undefined) {
      map.points.splice(+t.dataset.del, 1);
    } else return;
    if (t.id !== 'cancel') { save(); onPointsChanged(); }
    pendingPx = pendingLL = null;
    draw();
  });

  // Two pairs always fit exactly, so they can't show an error, but they can still be
  // implausible: two spots close together on the map, or a scale no real map has.
  // (Ryan's hike: a bad pair left the dot kilometres off the map.)
  function twoPointWarning(): string | null {
    const [a, b] = map.points, f = fitPoints(map.points);
    if (!f) return null;
    if (Math.hypot(a.px[0] - b.px[0], a.px[1] - b.px[1]) < 0.15 * Math.hypot(map.w, map.h))
      return 'Those two spots are close together on the map: add one far from them, or redo one';
    if (f.metersPerPx < 0.05 || f.metersPerPx > 60)
      return `These two pairs give an unlikely scale (${f.metersPerPx < 1 ? f.metersPerPx.toFixed(2) : Math.round(f.metersPerPx)} m per map pixel): one is probably off. Delete it with ✕ and redo it`;
    return null;
  }

  function draw() {
    phLayer.clearLayers();
    satLayer.clearLayers();
    const res = residuals(map.points);
    const err = rms(map.points);
    const sus = suspect(map.points);
    // Flag the suspect only if dropping it would at least halve the error.
    const bad = sus && err !== null && err > 10 && sus.rmsWithout < err / 2 ? sus.index : -1;

    map.points.forEach((p, i) => {
      const cls = i === bad ? 'bad' : '';
      L.marker(pxToSimple(p.px), { icon: pin(i + 1, cls), interactive: false }).addTo(phLayer);
      L.marker(p.ll, { icon: pin(i + 1, cls), interactive: false }).addTo(satLayer);
    });
    const n = map.points.length;
    const flex = map.warp === 'flexible' && canFlex(map.points) ? makeWarp(map.points, 'flexible', map.w, map.h) : null;
    if (pendingPx) L.marker(pxToSimple(pendingPx), { icon: pin(n + 1, 'pending'), interactive: false }).addTo(phLayer);
    if (pendingLL) L.marker(pendingLL, { icon: pin(n + 1, 'pending'), interactive: false }).addTo(satLayer);

    const offline = navigator.onLine ? '' : 'Offline: satellite imagery needs a connection · ';
    const hint = offline + (pendingPx && !pendingLL ? `Tap the same spot on the satellite`
      : pendingPx ? `Zoom in and re-tap either side to adjust`
      : n < 2 ? `Tap a spot on the photo (${n}/2)${!me && n === 0 ? (locErr ? ` · ${locErr}: pan the satellite to the map’s area` : ' · finding your location…') : ''}`
      : !fitPoints(map.points) ? (n === 2 ? 'Those two spots are the same · pick two far apart' : 'Points are in a line · add one off to the side')
      : n === 2 && twoPointWarning() ? twoPointWarning()!
      : n < 4 ? `Ready to navigate · ${n === 2 ? '2 points can’t show their own error; ' : ''}add ${4 - n} more to check accuracy`
      : flex && flex.folds.length ? `Flexible fit folds near ${flex.folds.map(i => '#' + (i + 1)).join(', ')}: check those points`
      : bad >= 0 ? `Fit ±${Math.round(err!)} m · #${bad + 1} looks mis-tapped (±${Math.round(sus!.rmsWithout)} m without it)`
      : flex ? `Flexible: follows every point exactly · the rigid fit is ±${Math.round(err!)} m off, so the map is ${err! > 25 ? 'stretched' : 'nearly true to scale'}`
      : n >= 5 && err! > 25 ? `Fit ±${Math.round(err!)} m · this map looks stretched (ski maps often are): try Flexible`
      : `Fit ±${Math.round(err!)} m${n < 5 ? ' · 5+ points to spot a mis-tap' : ''}`);
    const actions = pendingPx
      ? `<div class="actions"><button id="cancel" class="btn">Cancel</button><button id="add" class="btn on" ${pendingLL ? '' : 'disabled'}>Add pair ${n + 1}</button></div>`
      : '';
    const chips = map.points.map((_, i) =>
      `<span class="chip ${i === bad ? 'bad' : ''}">${i + 1}${res ? ` · ${Math.round(res[i])} m` : ''}<b data-del="${i}">✕</b></span>`
    ).join('');
    // Rigid vs Flexible (a smooth warp through every point, for painted/ski maps).
    const modes = !pendingPx && canFlex(map.points)
      ? `<div class="modes"><button class="${flex ? '' : 'on'}" data-mode="rigid">Rigid</button><button class="${flex ? 'on' : ''}" data-mode="flexible">Flexible (ski maps)</button></div>`
      : '';
    bar.innerHTML = `<div class="hint">${hint}</div>${modes}${actions || `<div class="chips">${chips}</div>`}`;
  }
  draw();

  return () => { navigator.geolocation.clearWatch(watch); ro.disconnect(); ph.remove(); sat.remove(); URL.revokeObjectURL(url); };
}
