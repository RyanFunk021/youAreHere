// Waypoints: parse whatever people paste (coordinates or a map link) into a lat/lng.
// Pure — no DOM — so it can be tested directly.
import type { LatLng } from './georef';

export interface Waypoint { id: string; lat: number; lng: number; name: string; created: number }

export type Parsed = { ll: LatLng } | { error: string };

const NUM = String.raw`[-+]?\d{1,3}(?:\.\d+)?`;
const ok = (lat: number, lng: number): Parsed =>
  Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)
    ? { ll: [lat, lng] }
    : { error: 'Those numbers aren’t a valid latitude and longitude.' };

// Degrees + optional minutes + optional seconds + hemisphere, e.g. 40°49'48.2"N or 89 48.5 W
function dms(part: string): number | null {
  const m = part.match(/(\d{1,3}(?:\.\d+)?)\s*[°º d:\s]\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′’m:\s]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:["″”s]|'')?\s*)?([NSEW])/i);
  if (!m) return null;
  const v = +m[1] + (m[2] ? +m[2] / 60 : 0) + (m[3] ? +m[3] / 3600 : 0);
  return /[SW]/i.test(m[4]) ? -v : v;
}

export function parseLatLng(input: string): Parsed {
  const s = input.trim();
  if (!s) return { error: 'Paste coordinates or a map link.' };

  // Short share links redirect server-side; a web page can't follow them.
  if (/(maps\.app\.goo\.gl|goo\.gl\/maps|maps\.apple\/p\/|apple\.co\/)/i.test(s))
    return { error: 'Short map links can’t be opened here. In the map app, copy the coordinates instead (e.g. 40.8312, -89.8015).' };

  // Map URLs and geo: URIs, most specific first.
  const url = [
    new RegExp(String.raw`!3d(${NUM})!4d(${NUM})`),                       // Google place data
    new RegExp(String.raw`@(${NUM}),(${NUM})`),                            // Google /@lat,lng,zoom
    new RegExp(String.raw`[?&](?:ll|q|query|destination|daddr|sll|center|coordinate)=(${NUM})(?:,|%2C)\s*(${NUM})`, 'i'),
    new RegExp(String.raw`geo:(${NUM}),(${NUM})`, 'i'),
  ];
  for (const re of url) { const m = s.match(re); if (m) return ok(+m[1], +m[2]); }

  // Hemisphere letters: degrees/minutes/seconds or decimal with N/S/E/W.
  if (/[NS]/i.test(s) && /[EW]/i.test(s)) {
    const i = s.search(/[NS]/i);
    const lat = dms(s.slice(0, i + 1)), lng = dms(s.slice(i + 1));
    const lead = s.match(/^\s*([NS])\s*(\d+(?:\.\d+)?)[°\s,]*([EW])\s*(\d+(?:\.\d+)?)/i); // N40.83 W89.80
    if (lead) return ok((/S/i.test(lead[1]) ? -1 : 1) * +lead[2], (/W/i.test(lead[3]) ? -1 : 1) * +lead[4]);
    if (lat != null && lng != null) return ok(lat, lng);
  }

  // Plain decimal pair: "40.83, -89.80", "40.83 -89.80", "40.83,-89.80"
  const m = s.match(new RegExp(String.raw`(${NUM})\s*[,;\s]\s*(${NUM})`));
  if (m) return ok(+m[1], +m[2]);

  return { error: 'Couldn’t find coordinates. Try “40.8312, -89.8015” or a full map link.' };
}

// Initial compass bearing from a to b, degrees clockwise from north.
export function bearingDeg(a: LatLng, b: LatLng): number {
  const D = Math.PI / 180, f1 = a[0] * D, f2 = b[0] * D, dl = (b[1] - a[1]) * D;
  const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return ((Math.atan2(y, x) / D) + 360) % 360;
}

export const compass8 = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

// A link that opens the app with this waypoint added to the current map.
export const waypointLink = (w: Pick<Waypoint, 'lat' | 'lng' | 'name'>) =>
  `${location.origin}${location.pathname}?wp=${w.lat.toFixed(6)},${w.lng.toFixed(6)}${w.name ? `&name=${encodeURIComponent(w.name)}` : ''}`;

export const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
