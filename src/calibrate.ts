import * as L from 'leaflet';
import { fitAffine, pxToLL, residuals, rms, suspect, type Px } from './georef';
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

  const phLayer = L.layerGroup().addTo(ph);
  const satLayer = L.layerGroup().addTo(sat);
  let pending: Px | null = null;

  ph.on('click', e => {
    pending = simpleToPx(e.latlng);
    // Once a fit exists, jump the satellite to where it predicts this pixel is.
    const f = fitAffine(map.points);
    if (f) sat.panTo(pxToLL(f, pending));
    draw();
  });

  sat.on('click', e => {
    if (!pending) return;
    map.points.push({ px: pending, ll: [e.latlng.lat, e.latlng.lng] });
    pending = null;
    save();
    onPointsChanged();
    draw();
  });

  bar.addEventListener('click', e => {
    const i = (e.target as HTMLElement).dataset.del;
    if (i === undefined) return;
    map.points.splice(+i, 1);
    save();
    onPointsChanged();
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
    if (pending) L.marker(pxToSimple(pending), { icon: pin(map.points.length + 1, 'pending'), interactive: false }).addTo(phLayer);

    const n = map.points.length;
    const hint = pending ? `Now tap point ${n + 1} on the satellite`
      : n < 3 ? `Tap a spot on the photo (${n}/3)`
      : n < 4 ? 'Ready to navigate · add a 4th point to check accuracy'
      : bad >= 0 ? `Fit ±${Math.round(err!)} m · #${bad + 1} looks mis-tapped (±${Math.round(sus!.rmsWithout)} m without it)`
      : `Fit ±${Math.round(err!)} m${n < 5 ? ' · 5+ points to spot a mis-tap' : ''}`;
    const chips = map.points.map((_, i) =>
      `<span class="chip ${i === bad ? 'bad' : ''}">${i + 1}${res ? ` · ${Math.round(res[i])} m` : ''}<b data-del="${i}">✕</b></span>`
    ).join('');
    bar.innerHTML = `<div class="hint">${hint}</div><div class="chips">${chips}</div>`;
  }
  draw();

  return () => { ph.remove(); sat.remove(); URL.revokeObjectURL(url); };
}
