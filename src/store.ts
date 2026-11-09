import { get, set } from 'idb-keyval';
import type { ControlPoint } from './georef';

// v1: one map slot. Control points are the source of truth; the fit is derived.
export interface SavedMap { blob: Blob; w: number; h: number; points: ControlPoint[] }

const KEY = 'map';
export const loadMap = () => get<SavedMap>(KEY);
export const saveMap = (m: SavedMap) => set(KEY, m);
