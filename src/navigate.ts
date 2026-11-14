import * as L from 'leaflet';
import { distM, fitPoints, llToPx, northOnPhotoDeg, pathM, type LatLng, type Pt } from './georef';
import { compassWidget } from './compass';
import { photoMap, pxToSimple } from './photo';
import { MAX_TRAIL_ACCURACY_M, MIN_TRAIL_STEP_M } from './config';
import { getSetting, loadPhotos, loadTrail, savePhotos, saveTrail, setSetting, type Crumb, type SavedMap, type Trail } from './store';
import { describe, importPhotos, type HikePhoto } from './photos';
import { bearingDeg, compass8, esc, parseLatLng, waypointLink, type Waypoint } from './waypoint';
import { loadWaypoints, saveWaypoints } from './store';

const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);

export function showNavigate(root: HTMLElement, map: SavedMap) {
  root.innerHTML = `<div id="nav"></div><button id="recenter" class="fab" aria-label="Zoom to my location">◎</button>
    <button id="fitmap" class="fab fitfab" aria-label="Show the whole map">⤢</button>
    <button id="addphotos" class="fab camfab" aria-label="Add photos">📷</button>
    <button id="addwp" class="fab wpfab" aria-label="Add a waypoint">📍</button><input id="photofile" type="file" accept="image/*" multiple hidden>
    <div id="gps" class="status">Waiting for GPS…</div>`;
  const status = root.querySelector<HTMLElement>('#gps')!;
  const fit = fitPoints(map.points)!;
  const url = URL.createObjectURL(map.blob);
  const m = photoMap(root.querySelector<HTMLElement>('#nav')!, url, map.w, map.h);
  const toMap = (p: Pt) => pxToSimple(llToPx(fit, [p[0], p[1]]));

  // Breadcrumbs are saved per map as lat/lng (so recalibrating re-projects them).
  // Earlier rides load as their own segments; this session appends a new one.
  const style = { color: '#ff2d55', weight: 4, opacity: 0.85 };
  let past: Trail | null = null;      // null until loaded; never save before then
  let pastM = 0;
  const seg: Crumb[] = [];
  let segM = 0;
  let dirty = false;
  const pastLine = L.polyline([], style).addTo(m);
  const trail = L.polyline([], style).addTo(m);
  loadTrail(map.id).then(t => {
    past = t;
    pastM = t.reduce((sum, s) => sum + pathM(s), 0);
    pastLine.setLatLngs(t.map(s => s.map(toMap)));
  });
  const save = () => {
    if (!past || !dirty) return;
    dirty = false;
    saveTrail(map.id, seg.length > 1 ? [...past, seg] : past);
  };
  const autosave = setInterval(save, 5000);
  const onHide = () => { if (document.visibilityState === 'hidden') save(); };
  document.addEventListener('visibilitychange', onHide);
  const acc = L.circle([0, 0], { radius: 1, color: '#007aff', weight: 1, fillOpacity: 0.12, interactive: false });
  const dot = L.circleMarker([0, 0], { className: 'me-dot', radius: 8, color: '#fff', weight: 3, fillColor: '#007aff', fillOpacity: 1, interactive: false });
  let here: L.LatLng | null = null;
  let hereLL: LatLng | null = null;
  // Free panning: any touch, drag or wheel on the map means "leave the view alone".
  let userMoved = false, centred = false;
  const navEl = root.querySelector<HTMLElement>('#nav')!;
  for (const ev of ['pointerdown', 'touchstart', 'wheel']) navEl.addEventListener(ev, () => { userMoved = true; }, { passive: true });
  // ◎: centre on you at a zoom showing roughly 300 m across, whatever the map's scale,
  // but never past 2 screen px per map px: a coarse scan (8.7 m/px USGS topo) would
  // otherwise be magnified into a blur.
  const zoomToMe = () => {
    if (!here) return;
    const z = Math.min(Math.log2((fit.metersPerPx * navEl.clientWidth) / 300), 1);
    m.setView(here, Math.min(Math.max(z, m.getMinZoom()), m.getMaxZoom()));
  };
  let lockFailed = false;
  let fixes = 0;

  // While waiting, show elapsed time and the permission state, so a blocked
  // permission doesn't look the same as a slow fix.
  const t0 = Date.now();
  let perm = '';
  navigator.permissions?.query({ name: 'geolocation' }).then(p => { perm = p.state; p.onchange = () => { perm = p.state; }; }).catch(() => {});
  let lastErr = '';
  const waiting = setInterval(() => {
    if (fixes) return;
    status.textContent = `Waiting for GPS… ${Math.round((Date.now() - t0) / 1000)} s${perm ? ` · permission: ${perm}` : ''}${lastErr ? ` · ${lastErr}` : ''}`;
  }, 500);

  // Location-blocked panel: a page can't force the browser's prompt back, but retrying
  // from a tap often re-prompts on iOS; if it fails again instantly, offer Reload + the setting.
  const fix = document.createElement('div');
  fix.className = 'locfix';
  fix.hidden = true;
  fix.innerHTML = `<div class="msg">Location is blocked for this page.</div>
    <button class="btn on" data-loc="ask">📍 Ask for location again</button>
    <div class="more" hidden>
      <div class="steps">Still blocked. <b>Close the browser completely</b> (swipe it away in the app switcher), reopen this page and tap <b>Allow</b>. If it never asks: iPhone Settings → Apps → Chrome → Location (Safari: Privacy &amp; Security → Location Services → Safari Websites) → <b>While Using the App</b> or <b>Ask Next Time</b>.</div>
      <button class="btn" data-loc="reload">Reload page</button>
    </div>`;
  root.appendChild(fix);
  let asks = 0;
  fix.addEventListener('click', e => {
    const a = (e.target as HTMLElement).dataset.loc;
    if (a === 'reload') location.reload();
    if (a !== 'ask') return;
    asks++;
    lastErr = '';
    navigator.geolocation.clearWatch(watch);
    watch = startWatch(); // inside the tap, so the browser may show its prompt again
  });

  const startWatch = () => navigator.geolocation.watchPosition(pos => {
    fix.hidden = true;
    const { latitude, longitude, accuracy } = pos.coords;
    fixes++;
    // Status first, so a failure in the map code below can't leave "Waiting…" on screen.
    const ll: LatLng = [latitude, longitude];
    // Skip fixes that are too inaccurate, or too close to the last point (jitter while stopped).
    if (accuracy <= MAX_TRAIL_ACCURACY_M) {
      const last = seg[seg.length - 1];
      const step = last ? distM(last, ll) : 0;
      if (!last || step >= MIN_TRAIL_STEP_M) { seg.push([latitude, longitude, Date.now()]); segM += step; dirty = true; trail.addLatLng(toMap(ll)); }
    }
    status.textContent = `±${Math.round(accuracy)} m · this ride ${km(segM)} · total ${km(pastM + segM)}${targetText(ll)}${lockFailed ? ' · screen may sleep' : ''}`;
    here = toMap(ll);
    hereLL = ll;
    acc.setLatLng(here).setRadius(accuracy / fit.metersPerPx).addTo(m);
    dot.setLatLng(here).addTo(m);
    // Centre on the first fix only if the user hasn't touched the map yet. After that the
    // map never moves on its own (Corey: let your location go off-screen; ◎ brings it back).
    if (!userMoved && !centred) { centred = true; zoomToMe(); }
  }, err => {
    // 1 = denied, 2 = unavailable, 3 = timeout (the watch keeps trying after a timeout).
    lastErr = err.code === 1
      ? 'location blocked'
      : err.code === 2 ? 'Location unavailable: is Location Services on?'
      : 'no fix after 20 s, still trying (try outdoors)';
    if (!fixes || err.code !== 3) status.textContent = `GPS: ${lastErr}`;
    if (err.code === 1) {
      fix.hidden = false;
      (fix.querySelector('.more') as HTMLElement).hidden = asks === 0;
    }
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  let watch = startWatch();

  root.querySelector('#recenter')!.addEventListener('click', zoomToMe);
  root.querySelector('#fitmap')!.addEventListener('click', () => m.fitBounds(L.latLngBounds([[-map.h, 0], [0, map.w]])));
  const removeCompass = compassWidget(root, northOnPhotoDeg(fit));

  // Hike photos: camera dots on the map; tap one to view it.
  let photos: HikePhoto[] = [];
  const photoLayer = L.layerGroup().addTo(m);
  const camIcon = L.divIcon({ className: 'cam', html: '📷', iconSize: [30, 30], iconAnchor: [15, 15] });
  const drawPhotos = () => {
    photoLayer.clearLayers();
    for (const p of photos) L.marker(toMap([p.lat, p.lng]), { icon: camIcon }).on('click', () => viewPhoto(p)).addTo(photoLayer);
  };
  loadPhotos(map.id).then(p => { photos = p; drawPhotos(); });

  const viewPhoto = (p: HikePhoto) => {
    const src = URL.createObjectURL(p.full);
    const box = document.createElement('div');
    box.className = 'lightbox';
    const how = p.how === 'gps' ? 'placed by photo location' : p.how === 'time' ? 'placed by time on your trail' : 'placed at your spot when taken';
    box.innerHTML = `<img alt=""><div class="cap"></div><div class="row"><button class="btn danger" data-a="del">Delete photo</button><button class="btn on" data-a="close">Close</button></div>`;
    box.querySelector('img')!.src = src;
    box.querySelector('.cap')!.textContent = `${p.t ? new Date(p.t).toLocaleString() : ''} · ${how}`;
    box.addEventListener('click', async e => {
      const a = (e.target as HTMLElement).dataset.a;
      if (!a) return;
      if (a === 'del') {
        if (!confirm('Delete this photo from the map?')) return;
        photos = photos.filter(x => x.id !== p.id);
        await savePhotos(map.id, photos);
        drawPhotos();
      }
      URL.revokeObjectURL(src);
      box.remove();
    });
    root.appendChild(box);
  };

  // Waypoints: highlighted stars; the "target" (last added or tapped) shows its
  // straight-line distance and direction in the status line.
  let waypoints: Waypoint[] = [];
  let target: Waypoint | null = null;
  const wpLayer = L.layerGroup().addTo(m);
  const targetText = (from: LatLng) => target
    ? ` · ⭐ ${target.name ? target.name + ' ' : ''}${km(distM(from, [target.lat, target.lng]))} ${compass8(bearingDeg(from, [target.lat, target.lng]))}`
    : '';
  const drawWaypoints = () => {
    wpLayer.clearLayers();
    for (const w of waypoints) {
      const icon = L.divIcon({ className: `wp${w === target ? ' target' : ''}`, html: `<span class="star">⭐</span>${w.name ? `<span class="wpname">${esc(w.name)}</span>` : ''}`, iconSize: [34, 34], iconAnchor: [17, 17] });
      L.marker(toMap([w.lat, w.lng]), { icon, zIndexOffset: 1000 }).on('click', () => { target = w; drawWaypoints(); showWaypoint(w); }).addTo(wpLayer);
    }
  };
  loadWaypoints(map.id).then(w => { waypoints = w; target = [...w].sort((a, b) => b.created - a.created)[0] ?? null; drawWaypoints(); });

  const sheet = (html: string) => {
    root.querySelector('.sheet')?.remove();
    const el = document.createElement('div');
    el.className = 'sheet';
    el.innerHTML = html;
    root.appendChild(el);
    return el;
  };
  const showWaypoint = (w: Waypoint) => {
    const d = hereLL ? `${km(distM(hereLL, [w.lat, w.lng]))} ${compass8(bearingDeg(hereLL, [w.lat, w.lng]))} of you · ` : '';
    const el = sheet(`<div class="msg">⭐ ${esc(w.name || 'Waypoint')}</div><div class="sub">${d}${w.lat.toFixed(5)}, ${w.lng.toFixed(5)}</div>
      <div class="row"><button class="btn" data-w="share">Share link</button><button class="btn danger" data-w="del">Delete</button><button class="btn on" data-w="close">Close</button></div>`);
    el.addEventListener('click', async e => {
      const a = (e.target as HTMLElement).dataset.w;
      if (a === 'close') el.remove();
      if (a === 'share') {
        const url = waypointLink(w);
        if (navigator.share) await navigator.share({ title: w.name || 'Waypoint', url }).catch(() => {});
        else { await navigator.clipboard?.writeText(url).catch(() => {}); prompt('Link copied. Send it to someone with this map:', url); }
      }
      if (a === 'del' && confirm('Delete this waypoint?')) {
        waypoints = waypoints.filter(x => x.id !== w.id);
        if (target?.id === w.id) target = waypoints[waypoints.length - 1] ?? null;
        await saveWaypoints(map.id, waypoints);
        drawWaypoints();
        el.remove();
      }
    });
  };
  root.querySelector('#addwp')!.addEventListener('click', () => {
    const el = sheet(`<div class="msg">Add a waypoint</div>
      <input class="wpin" placeholder="Paste coordinates or a map link" autocomplete="off" autocapitalize="off">
      <input class="wpname-in" placeholder="Name (optional)">
      <div class="err" hidden></div>
      <div class="row"><button class="btn" data-w="cancel">Cancel</button><button class="btn on" data-w="add">Add</button></div>`);
    const input = el.querySelector<HTMLInputElement>('.wpin')!;
    input.focus();
    el.addEventListener('click', async e => {
      const a = (e.target as HTMLElement).dataset.w;
      if (a === 'cancel') el.remove();
      if (a !== 'add') return;
      const r = parseLatLng(input.value);
      const err = el.querySelector<HTMLElement>('.err')!;
      if ('error' in r) { err.textContent = r.error; err.hidden = false; return; }
      const w: Waypoint = { id: Date.now().toString(36), lat: r.ll[0], lng: r.ll[1], name: el.querySelector<HTMLInputElement>('.wpname-in')!.value.trim(), created: Date.now() };
      waypoints = [...waypoints, w];
      target = w;
      await saveWaypoints(map.id, waypoints);
      drawWaypoints();
      m.setView(toMap([w.lat, w.lng]), Math.max(m.getZoom(), 0));
      userMoved = true; // the view is now where the user asked
      el.remove();
    });
  });

  const photoInput = root.querySelector<HTMLInputElement>('#photofile')!;
  root.querySelector('#addphotos')!.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', async () => {
    const files = [...(photoInput.files ?? [])];
    photoInput.value = '';
    if (!files.length) return;
    try {
      const r = await importPhotos(files, [...(past ?? []), seg], hereLL, s => { status.textContent = s; });
      photos = [...photos, ...r.added];
      await savePhotos(map.id, photos);
      drawPhotos();
      status.textContent = describe(r);
    } catch (e) {
      status.textContent = `Couldn't add photos: ${e}`;
    }
  });

  // Screen: kept on by default. Battery saver lets it sleep; a web page gets no GPS
  // while the screen is off, so breadcrumbs are then recorded whenever you look at the
  // map, and joined with straight lines across the gaps.
  // A silent wake-lock failure looks like a GPS failure mid-ride, so say so in the status.
  let lock: WakeLockSentinel | undefined;
  let saver = false;
  const grab = async () => {
    if (saver) return;
    try { await lock?.release(); lock = await navigator.wakeLock.request('screen'); lockFailed = false; }
    catch { lockFailed = true; status.textContent += ' · screen may sleep'; }
  };
  const onVis = () => { if (document.visibilityState === 'visible') grab(); };
  document.addEventListener('visibilitychange', onVis);

  const power = document.createElement('button');
  power.className = 'power';
  root.appendChild(power);
  const showPower = () => { power.textContent = saver ? '🔋 Battery saver' : '🔆 Screen stays on'; power.classList.toggle('on', saver); };
  getSetting<boolean>('batterySaver').then(v => { saver = !!v; showPower(); if (!saver) grab(); });
  power.addEventListener('click', async () => {
    saver = !saver;
    setSetting('batterySaver', saver);
    showPower();
    if (saver) { await lock?.release(); lock = undefined; lockFailed = false; }
    else grab();
    status.textContent = saver
      ? 'Battery saver: screen can sleep. Breadcrumbs record whenever you look at the map.'
      : 'Screen stays on. Breadcrumbs record continuously.';
  });

  return () => {
    removeCompass();
    fix.remove();
    power.remove();
    root.querySelector('.lightbox')?.remove();
    root.querySelector('.sheet')?.remove();
    save();
    clearInterval(autosave);
    document.removeEventListener('visibilitychange', onHide);
    clearInterval(waiting);
    navigator.geolocation.clearWatch(watch);
    document.removeEventListener('visibilitychange', onVis);
    lock?.release();
    m.remove();
    URL.revokeObjectURL(url);
  };
}
