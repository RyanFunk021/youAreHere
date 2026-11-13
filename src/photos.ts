// Hike photos as camera dots on the map.
//
// Placement, in order of preference:
//   1. 'gps'  — the photo's own EXIF location (iOS usually strips this from web uploads)
//   2. 'time' — its EXIF capture time, matched against the timestamped breadcrumbs
//   3. 'now'  — no metadata, but the file was just created (taken from Navigate) and we
//               have a GPS fix: put it where you are
// Anything else is skipped and counted, so the report shows what the phone kept.
import type { LatLng } from './georef';
import type { Trail } from './store';

export interface HikePhoto { id: string; lat: number; lng: number; t: number | null; how: 'gps' | 'time' | 'now'; full: Blob }

const FULL_PX = 1600;                 // stored size: plenty for a phone screen, ~300 KB each
const MAX_GAP_MS = 10 * 60_000;       // a photo must fall within 10 min of a breadcrumb
const JUST_TAKEN_MS = 3 * 60_000;     // "taken just now" window for in-hike captures

async function shrink(file: Blob): Promise<Blob> {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  const k = Math.min(1, FULL_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/jpeg', 0.85));
}

// Interpolate along the breadcrumbs at time t; else the nearest crumb within MAX_GAP_MS.
export function placeByTime(t: number, trail: Trail): LatLng | null {
  let best: LatLng | null = null;
  let bestGap = Infinity;
  for (const seg of trail) {
    for (let i = 0; i < seg.length; i++) {
      const a = seg[i], ta = a[2];
      if (ta == null) continue;
      const gap = Math.abs(ta - t);
      if (gap < bestGap) { bestGap = gap; best = [a[0], a[1]]; }
      const b = seg[i + 1], tb = b?.[2];
      if (b && tb != null && ta <= t && t <= tb) {
        const f = tb > ta ? (t - ta) / (tb - ta) : 0;
        return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
      }
    }
  }
  return bestGap <= MAX_GAP_MS ? best : null;
}

export interface ImportReport { added: HikePhoto[]; byGps: number; byTime: number; byNow: number; noMeta: number; outside: number }

export async function importPhotos(files: File[], trail: Trail, here: LatLng | null, onStatus: (s: string) => void): Promise<ImportReport> {
  onStatus('Loading photo reader…');
  const exifr = (await import('exifr')).default;
  const r: ImportReport = { added: [], byGps: 0, byTime: 0, byNow: 0, noMeta: 0, outside: 0 };
  for (const [i, f] of files.entries()) {
    onStatus(`Reading photo ${i + 1} of ${files.length}…`);
    const x = await exifr.parse(f).catch(() => null) as { latitude?: number; longitude?: number; DateTimeOriginal?: Date } | null;
    const t = x?.DateTimeOriginal instanceof Date ? x.DateTimeOriginal.getTime() : null;
    let ll: LatLng | null = null;
    let how: HikePhoto['how'] | null = null;
    if (x?.latitude != null && x?.longitude != null) { ll = [x.latitude, x.longitude]; how = 'gps'; }
    else if (t != null) { ll = placeByTime(t, trail); how = 'time'; if (!ll) { r.outside++; continue; } }
    else if (here && Date.now() - f.lastModified < JUST_TAKEN_MS) { ll = here; how = 'now'; }
    else { r.noMeta++; continue; }
    r.added.push({ id: Date.now().toString(36) + i, lat: ll[0], lng: ll[1], t: t ?? f.lastModified, how, full: await shrink(f) });
    if (how === 'gps') r.byGps++; else if (how === 'time') r.byTime++; else r.byNow++;
  }
  return r;
}

export function describe(r: ImportReport): string {
  const parts = [`Added ${r.added.length} photo${r.added.length === 1 ? '' : 's'}`];
  const how = [r.byGps && `${r.byGps} by photo location`, r.byTime && `${r.byTime} by time on your trail`, r.byNow && `${r.byNow} at your current spot`].filter(Boolean);
  if (how.length) parts[0] += ` (${how.join(', ')})`;
  if (r.noMeta) parts.push(`${r.noMeta} had no location or time (the iPhone removed it)`);
  if (r.outside) parts.push(`${r.outside} taken away from your recorded trail`);
  return parts.join('. ') + '.';
}
