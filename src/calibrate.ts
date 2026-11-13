import * as L from 'leaflet';
import { fitAffine, pxToLL, residuals, rms, suspect, type LatLng, type Px } from './georef';
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
  else {
    // First calibration usually happens at the trailhead: start where the user is.
    sat.setView(HOME, HOME_ZOOM);
    navigator.geolocation.getCurrentPosition(p => sat.setView([p.coords.latitude, p.coords.longitude], 16), () => {}, { enableHighAccuracy: true });
  }

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
    const f = fitAffine(map.points);
    if (f && !pendingLL) sat.panTo(pxToLL(f, pendingPx));
    draw();
  });

  sat.on('click', e => {
    if (!pendingPx) return;
    pendingLL = [e.latlng.lat, e.latlng.lng];
    draw();
  });

  bar.addEventListener('click', e => {
    const t = e.target as HTMLElement;
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
    if (pendingPx) L.marker(pxToSimple(pendingPx), { icon: pin(n + 1, 'pending'), interactive: false }).addTo(phLayer);
    if (pendingLL) L.marker(pendingLL, { icon: pin(n + 1, 'pending'), interactive: false }).addTo(satLayer);

    const hint = pendingPx && !pendingLL ? `Tap the same spot on the satellite`
      : pendingPx ? `Zoom in and re-tap either side to adjust`
      : n < 3 ? `Tap a spot on the photo (${n}/3)`
      : !fitAffine(map.points) ? 'Points are in a line · add one off to the side'
      : n < 4 ? 'Ready to navigate · add a 4th point to check accuracy'
      : bad >= 0 ? `Fit ±${Math.round(err!)} m · #${bad + 1} looks mis-tapped (±${Math.round(sus!.rmsWithout)} m without it)`
      : `Fit ±${Math.round(err!)} m${n < 5 ? ' · 5+ points to spot a mis-tap' : ''}`;
    const actions = pendingPx
      ? `<div class="actions"><button id="cancel" class="btn">Cancel</button><button id="add" class="btn on" ${pendingLL ? '' : 'disabled'}>Add pair ${n + 1}</button></div>`
      : '';
    const chips = map.points.map((_, i) =>
      `<span class="chip ${i === bad ? 'bad' : ''}">${i + 1}${res ? ` · ${Math.round(res[i])} m` : ''}<b data-del="${i}">✕</b></span>`
    ).join('');
    bar.innerHTML = `<div class="hint">${hint}</div>${actions || `<div class="chips">${chips}</div>`}`;
  }
  draw();

  return () => { ro.disconnect(); ph.remove(); sat.remove(); URL.revokeObjectURL(url); };
}
