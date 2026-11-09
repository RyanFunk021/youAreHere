import type { LatLng } from './georef';

// Hardcoded for the prototype: Peoria, IL (PAMBA trails).
export const HOME: LatLng = [40.6936, -89.589];
export const HOME_ZOOM = 11;

export const SATELLITE = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
};

// OSM shows trails that tree canopy hides in imagery — best source for trail-junction control points.
export const STREETS = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};

// Breadcrumbs skip fixes worse than this (startup / indoor fixes are often 100 m+).
export const MAX_TRAIL_ACCURACY_M = 50;
