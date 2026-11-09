import * as L from 'leaflet';
import type { Px } from './georef';

// Photo shown in Leaflet's CRS.Simple: 1 unit = 1 pixel, lat = -v, lng = u.
export const pxToSimple = (p: Px) => L.latLng(-p[1], p[0]);
export const simpleToPx = (ll: L.LatLng): Px => [ll.lng, -ll.lat];

export function photoMap(el: HTMLElement, url: string, w: number, h: number) {
  const m = L.map(el, {
    crs: L.CRS.Simple, minZoom: -6, maxZoom: 4, zoomSnap: 0.25,
    attributionControl: false, zoomControl: false,
  });
  const bounds = L.latLngBounds([[-h, 0], [0, w]]);
  L.imageOverlay(url, bounds).addTo(m);
  m.fitBounds(bounds);
  return m;
}

export const pin = (n: number, cls = '') =>
  L.divIcon({ className: `pin ${cls}`, html: `<span>${n}</span>`, iconSize: [14, 14], iconAnchor: [7, 7] });
