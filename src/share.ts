// Share a calibrated map phone-to-phone as one file (send it by Messages, Messenger,
// AirDrop, email...). No server: the file carries the image, calibration and waypoints.
// Trail and hike photos are deliberately left out; they're personal.
import type { ControlPoint } from './georef';
import type { SavedMap } from './store';
import type { Waypoint } from './waypoint';

const FORMAT = 'youAreHere-map';
export const isMapFile = (f: File) => f.type === 'application/json' || /\.json$/i.test(f.name);

interface MapFile { format: string; version: number; name: string; points: ControlPoint[]; waypoints: Waypoint[]; image: string }

const toDataURL = (b: Blob) => new Promise<string>((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(r.result as string);
  r.onerror = () => fail(r.error);
  r.readAsDataURL(b);
});

export async function packMap(map: SavedMap, waypoints: Waypoint[]): Promise<File> {
  const body: MapFile = { format: FORMAT, version: 1, name: map.name, points: map.points, waypoints, image: await toDataURL(map.blob) };
  const safe = map.name.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'map';
  return new File([JSON.stringify(body)], `${safe}.youarehere.json`, { type: 'application/json' });
}

// The file comes from someone else's phone: check every field before trusting it.
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
export async function unpackMap(file: File): Promise<{ name: string; blob: Blob; points: ControlPoint[]; waypoints: Waypoint[] }> {
  let d: Partial<MapFile>;
  try { d = JSON.parse(await file.text()); } catch { throw new Error('This file isn’t a youAreHere map (not valid JSON).'); }
  if (d?.format !== FORMAT) throw new Error('This file isn’t a youAreHere map.');
  if (typeof d.image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(d.image)) throw new Error('The map file has no usable image.');
  const points = (Array.isArray(d.points) ? d.points : []).filter(p =>
    Array.isArray(p?.px) && Array.isArray(p?.ll) && [...p.px, ...p.ll].length === 4 && [...p.px, ...p.ll].every(num)
    && Math.abs(p.ll[0]) <= 90 && Math.abs(p.ll[1]) <= 180).map(p => ({ px: [p.px[0], p.px[1]], ll: [p.ll[0], p.ll[1]] }) as ControlPoint);
  const waypoints = (Array.isArray(d.waypoints) ? d.waypoints : []).filter(w => num(w?.lat) && num(w?.lng) && Math.abs(w.lat) <= 90 && Math.abs(w.lng) <= 180)
    .map((w, i) => ({ id: Date.now().toString(36) + i, lat: w.lat, lng: w.lng, name: String(w.name ?? '').slice(0, 60), created: Date.now() + i }));
  const blob = await (await fetch(d.image)).blob();
  return { name: String(d.name ?? 'Shared map').slice(0, 60) || 'Shared map', blob, points, waypoints };
}

// Share sheet where the browser can share files; otherwise download the file.
export async function sendFile(file: File): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return 'shared'; }
    catch (e) { if ((e as Error).name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  return 'downloaded';
}
