import { get, set, del, update } from 'idb-keyval';
import { pathM, type ControlPoint } from './georef';

// Everything lives in IndexedDB on the device.
//   map:<id>    photo + control points (control points are the source of truth; the fit is derived)
//   trail:<id>  breadcrumbs as segments, one per Navigate session, so separate rides don't join up
//   maps        small index for the Maps screen, so listing doesn't load every photo
//   current     id of the last-opened map
export interface SavedMap { id: string; name: string; blob: Blob; w: number; h: number; points: ControlPoint[] }
export interface MapMeta { id: string; name: string; updated: number; points: number; trailM: number }
// Breadcrumb: [lat, lng, epoch ms]. Time added 2026-11-12 (older crumbs have none);
// it lets hike photos be placed by when they were taken.
export type Crumb = [number, number, number?];
export type Trail = Crumb[][];

const INDEX = 'maps', CURRENT = 'current', LEGACY = 'map';

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export async function listMaps(): Promise<MapMeta[]> {
  await migrate();
  // Stable order (newest added first): rows must not jump around after a rename or clear.
  return (await get<MapMeta[]>(INDEX)) ?? [];
}

export const loadMap = (id: string) => get<SavedMap>(`map:${id}`);
export const getCurrentId = () => get<string>(CURRENT);
export const setCurrentId = (id: string) => set(CURRENT, id);

export async function saveMap(m: SavedMap) {
  await set(`map:${m.id}`, m);
  await touch(m.id, { name: m.name, points: m.points.length });
}

export async function deleteMap(id: string) {
  await del(`map:${id}`);
  await del(`trail:${id}`);
  await update<MapMeta[]>(INDEX, idx => (idx ?? []).filter(x => x.id !== id));
  if ((await getCurrentId()) === id) await del(CURRENT);
}

export const loadTrail = async (id: string) => (await get<Trail>(`trail:${id}`)) ?? [];

export async function saveTrail(id: string, t: Trail) {
  await set(`trail:${id}`, t);
  await touch(id, { trailM: t.reduce((s, seg) => s + pathM(seg), 0) });
}

// Read-modify-write in one transaction so trail autosaves and map saves can't clobber each other.
function touch(id: string, patch: Partial<MapMeta>) {
  return update<MapMeta[]>(INDEX, idx => {
    const list = idx ?? [];
    const i = list.findIndex(x => x.id === id);
    const next = { ...(i >= 0 ? list[i] : { id, name: 'Map', points: 0, trailM: 0 }), ...patch, updated: Date.now() } as MapMeta;
    if (i >= 0) list[i] = next; else list.unshift(next);
    return list;
  });
}

// v1 prototype stored a single map under 'map'. Move it into the library once.
let migrated = false;
async function migrate() {
  if (migrated) return;
  migrated = true;
  const old = await get<Omit<SavedMap, 'id' | 'name'>>(LEGACY);
  if (!old) return;
  const id = newId();
  await saveMap({ ...old, id, name: 'My first map' });
  await setCurrentId(id);
  await del(LEGACY); // only after the copy is safely written
}

// Small device-local settings (e.g. battery saver).
export const getSetting = <T>(k: string) => get<T>(`setting:${k}`);
export const setSetting = (k: string, v: unknown) => set(`setting:${k}`, v);

// Ask the browser not to evict our data under storage pressure / long disuse.
export async function persist(): Promise<boolean> {
  try { return (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false; }
  catch { return false; }
}
