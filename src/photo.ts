import * as L from 'leaflet';
import type { Px } from './georef';

// Photo shown in Leaflet's CRS.Simple: 1 unit = 1 pixel, lat = -v, lng = u.
export const pxToSimple = (p: Px) => L.latLng(-p[1], p[0]);
export const simpleToPx = (ll: L.LatLng): Px => [ll.lng, -ll.lat];

// The photo is drawn as 256 px tiles cut on the fly from one decoded image, not as a
// single <img> overlay. iOS WebKit stops drawing a large image once Leaflet sizes it to
// thousands of CSS px (WebKit bug 249645): on Ryan's hike, zooming in on a phone photo
// left the breadcrumbs visible but the map blank. Tiles keep every layer screen-sized.
// In CRS.Simple at zoom z, tile (x, y) covers image pixels [x, x+1) × [y, y+1) · 256/2^z.
const PhotoTiles = L.GridLayer.extend({
  initialize(this: L.GridLayer & { _img: HTMLImageElement; _ready: Promise<void> }, img: HTMLImageElement, ready: Promise<void>, options: L.GridLayerOptions) {
    this._img = img;
    this._ready = ready;
    L.setOptions(this, options);
  },
  createTile(this: L.GridLayer & { _img: HTMLImageElement; _ready: Promise<void> }, coords: L.Coords, done: L.DoneCallback) {
    const size = this.getTileSize(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const tile = document.createElement('canvas');
    tile.width = size.x * dpr;
    tile.height = size.y * dpr;
    this._ready.then(() => {
      const s = size.x / 2 ** coords.z; // image px per tile
      const g = tile.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      // Clip the source to the image so the destination keeps the right proportion.
      const sx = coords.x * s, sy = coords.y * s;
      const sw = Math.min(s, this._img.naturalWidth - sx), sh = Math.min(s, this._img.naturalHeight - sy);
      if (sw > 0 && sh > 0) g.drawImage(this._img, sx, sy, sw, sh, 0, 0, (sw / s) * tile.width, (sh / s) * tile.height);
      done(undefined, tile);
    }, err => done(err, tile));
    return tile;
  },
}) as unknown as new (img: HTMLImageElement, ready: Promise<void>, o: L.GridLayerOptions) => L.GridLayer;

export function photoMap(el: HTMLElement, url: string, w: number, h: number) {
  const m = L.map(el, {
    crs: L.CRS.Simple, minZoom: -6, maxZoom: 4, zoomSnap: 0.25,
    attributionControl: false, zoomControl: false,
  });
  const bounds = L.latLngBounds([[-h, 0], [0, w]]);
  const img = new Image();
  img.src = url;
  // minZoom matters: GridLayer defaults to 0, and fitting a 4000 px photo on a phone needs ≈ −3.5.
  new PhotoTiles(img, img.decode(), { bounds, tileSize: 256, keepBuffer: 1, updateWhenZooming: false, minZoom: -6, maxZoom: 4 }).addTo(m);
  // An invisible outline of the image, so other code (and tests) can find its extent.
  L.rectangle(bounds, { stroke: false, fill: false, interactive: false, className: 'photo-bounds' }).addTo(m);
  m.fitBounds(bounds);
  return m;
}

export const pin = (n: number, cls = '') =>
  L.divIcon({ className: `pin ${cls}`, html: `<span>${n}</span>`, iconSize: [14, 14], iconAnchor: [7, 7] });
