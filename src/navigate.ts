import * as L from 'leaflet';
import { distM, type LatLng, type Pt } from './georef';
import { makeWarp } from './warp';
import { compassWidget } from './compass';
import { photoMap, pxToSimple } from './photo';
import { MAX_TRAIL_ACCURACY_M, MIN_TRAIL_STEP_M } from './config';
import { crumbsM, getSetting, loadPhotos, loadTrack, newId, savePhotos, saveTrack, setSetting, trackM, trackTrail, type SavedMap, type Session, type Track } from './store';
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
  const fit = makeWarp(map.points, map.warp ?? 'rigid', map.w, map.h)!; // rigid or flexible (ski maps)
  const url = URL.createObjectURL(map.blob);
  const m = photoMap(root.querySelector<HTMLElement>('#nav')!, url, map.w, map.h);
  const toMap = (p: Pt) => pxToSimple(fit.toPx([p[0], p[1]]));

  // Breadcrumbs: dots where you've been (no lines between them), grouped into
  // sessions you can pause, end, resume and crop. Saved per map as lat/lng, so
  // recalibrating re-projects them. Opening Navigate continues the active session, or
  // starts a new one if the last was ended.
  let track: Track | null = null;     // null until loaded; never save before then
  let session: Session | null = null; // the active session, if any
  let dirty = false;
  let cropKeep: [number, number] | null = null; // crop preview range (indices into session crumbs)
  const dotsRenderer = L.canvas({ padding: 0.5 });
  const dots = L.layerGroup().addTo(m);
  const DOT_NOW = { renderer: dotsRenderer, radius: 3.5, stroke: false, fillColor: '#ff2d55', fillOpacity: 0.95, interactive: false };
  const DOT_PAST = { ...DOT_NOW, radius: 2.5, fillColor: '#ff6b81', fillOpacity: 0.5 };
  const DOT_CUT = { ...DOT_NOW, radius: 2.5, fillColor: '#8e8e93', fillOpacity: 0.35 };
  const drawDots = () => {
    dots.clearLayers();
    for (const s of track?.sessions ?? []) s.crumbs.forEach((c, i) => {
      const style = s !== cropTarget() || !cropKeep ? (s === session ? DOT_NOW : DOT_PAST) : (i >= cropKeep[0] && i <= cropKeep[1] ? DOT_NOW : DOT_CUT);
      L.circleMarker(toMap(c), style).addTo(dots);
    });
  };
  const recording = () => !!session && !!track && !track.paused;
  const lastSession = () => track?.sessions[track.sessions.length - 1] ?? null;
  const cropTarget = () => session ?? lastSession();
  const startSession = () => {
    session = { id: newId(), started: Date.now(), crumbs: [] };
    track!.sessions.push(session);
    track!.active = session.id;
    track!.paused = false;
    dirty = true;
  };
  let breakNext = false; // the next dot follows a pause
  loadTrack(map.id).then(t => {
    track = t;
    session = t.sessions.find(x => x.id === t.active) ?? null;
    if (!session) startSession();
    drawDots();
    renderPill();
  });
  const save = () => {
    if (!track || !dirty) return;
    dirty = false;
    saveTrack(map.id, track);
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
  let offBy = 0;
  const fitWhole = () => m.fitBounds(L.latLngBounds([[-map.h, 0], [0, map.w]]));

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
    if (recording() && accuracy <= MAX_TRAIL_ACCURACY_M) {
      const crumbs = session!.crumbs, last = crumbs[crumbs.length - 1];
      if (!last || distM(last, ll) >= MIN_TRAIL_STEP_M) {
        crumbs.push(breakNext && last ? [latitude, longitude, Date.now(), 1] : [latitude, longitude, Date.now()]);
        breakNext = false;
        dirty = true;
        L.circleMarker(toMap(ll), DOT_NOW).addTo(dots);
      }
    }
    status.textContent = `±${Math.round(accuracy)} m · ${sessionText()}${targetText(ll)}${lockFailed ? ' · screen may sleep' : ''}`;
    here = toMap(ll);
    hereLL = ll;
    // Off the map image? (Usually a bad calibration.) Say how far, and don't fly the
    // view out to an empty background on the first fix: show the map instead.
    const px = fit.toPx(ll), cx = Math.min(Math.max(px[0], 0), map.w), cy = Math.min(Math.max(px[1], 0), map.h);
    offBy = Math.hypot(px[0] - cx, px[1] - cy) * fit.metersPerPx;
    acc.setLatLng(here).setRadius(accuracy / fit.metersPerPx).addTo(m);
    dot.setLatLng(here).addTo(m);
    // Centre on the first fix only if the user hasn't touched the map yet. After that the
    // map never moves on its own (Corey: let your location go off-screen; ◎ brings it back).
    if (!userMoved && !centred) { centred = true; if (offBy > 50) fitWhole(); else zoomToMe(); }
    if (offBy > 50) status.textContent += ` · you're ${km(offBy)} off this map: if you're actually on it, re-check the calibration`;
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
  root.querySelector('#fitmap')!.addEventListener('click', fitWhole);
  const removeCompass = compassWidget(root, fit.north);

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
      const r = await importPhotos(files, track ? trackTrail(track) : [], hereLL, s => { status.textContent = s; });
      photos = [...photos, ...r.added];
      await savePhotos(map.id, photos);
      drawPhotos();
      status.textContent = describe(r);
    } catch (e) {
      status.textContent = `Couldn't add photos: ${e}`;
    }
  });

  // Screen: kept on by default. Battery saver lets it sleep; a web page gets no GPS
  // while the screen is off, so dots are then recorded whenever you look at the map.
  // A silent wake-lock failure looks like a GPS failure mid-hike, so say so in the status.
  let lock: WakeLockSentinel | undefined;
  let saver = false;
  const grab = async () => {
    if (saver) return;
    try { await lock?.release(); lock = await navigator.wakeLock.request('screen'); lockFailed = false; }
    catch { lockFailed = true; status.textContent += ' · screen may sleep'; }
  };
  const onVis = () => { if (document.visibilityState === 'visible') grab(); };
  document.addEventListener('visibilitychange', onVis);
  getSetting<boolean>('batterySaver').then(v => { saver = !!v; if (!saver) grab(); renderPill(); });
  const setSaver = async (on: boolean) => {
    saver = on;
    setSetting('batterySaver', saver);
    if (saver) { await lock?.release(); lock = undefined; lockFailed = false; } else grab();
  };

  // Session pill (top left): state at a glance; tap for Pause / End / Resume / Crop.
  const timeOf = (t?: number) => (t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
  const sessionText = () => !track ? '' : recording()
    ? `${km(crumbsM(session!.crumbs))} this session · ${km(trackM(track))} total`
    : track.paused && session ? `paused · ${km(crumbsM(session.crumbs))} this session` : 'not recording';
  const pill = document.createElement('button');
  pill.className = 'pill';
  root.appendChild(pill);
  function renderPill() {
    if (!track) return;
    pill.className = `pill ${recording() ? 'rec' : track.paused && session ? 'paused' : 'off'}`;
    pill.textContent = (recording() ? '● Recording' : track.paused && session ? '❚❚ Paused' : '■ Not recording') + (saver ? ' · 🔋' : '');
  }
  const changed = () => { dirty = true; save(); drawDots(); renderPill(); if (hereLL) status.textContent = sessionText(); };

  const openSessionSheet = () => {
    if (!track) return;
    const s = session, last = lastSession();
    const info = (x: Session) => `Started ${new Date(x.started).toLocaleDateString()} ${timeOf(x.started)} · ${km(crumbsM(x.crumbs))} · ${x.crumbs.length} dots`;
    const el = sheet(`<div class="msg">${s ? (recording() ? '● Recording this session' : '❚❚ Session paused') : '■ Not recording'}</div>
      <div class="sub">${s ? info(s) : last ? 'Last session: ' + info(last) : 'No sessions yet'}</div>
      <div class="row">${s
        ? `${recording() ? '<button class="btn" data-s="pause">❚❚ Pause</button>' : '<button class="btn on" data-s="resume">▶ Resume</button>'}<button class="btn danger" data-s="end">■ End session</button>`
        : `<button class="btn on" data-s="start">▶ Start new session</button>${last ? '<button class="btn" data-s="resumelast">↺ Resume last</button>' : ''}`}</div>
      ${(s ?? last)?.crumbs.length ? `<div class="row"><button class="btn" data-s="crop">✂ Crop ${s ? 'this' : 'last'} session</button></div>` : ''}
      <div class="row"><button class="btn" data-s="saver">${saver ? '🔋 Battery saver is on: screen can sleep' : '🔆 Screen stays on: tap for battery saver'}</button></div>
      <div class="row"><button class="btn on" data-s="close">Close</button></div>`);
    el.addEventListener('click', e => {
      const a = (e.target as HTMLElement).dataset.s;
      if (!a) return;
      if (a === 'pause') { track!.paused = true; breakNext = true; }
      if (a === 'resume') track!.paused = false;
      if (a === 'end' && s) {
        s.ended = Date.now();
        if (s.crumbs.length < 2) track!.sessions = track!.sessions.filter(x => x !== s); // nothing worth keeping
        track!.active = null; track!.paused = false; session = null;
      }
      if (a === 'start') startSession();
      if (a === 'resumelast' && last) { delete last.ended; session = last; track!.active = last.id; track!.paused = false; breakNext = true; }
      if (a === 'saver') { setSaver(!saver); }
      if (a === 'crop') { el.remove(); openCrop(); return; }
      if (a === 'close') { el.remove(); return; }
      changed();
      openSessionSheet(); // refresh the sheet's buttons
      if (a === 'end') el.remove();
    });
  };
  pill.addEventListener('click', openSessionSheet);

  // Crop: drag the start and end to drop dots from before you set off or after you
  // finished (e.g. the drive home). Kept dots stay red; cropped ones turn grey.
  const openCrop = () => {
    const s = cropTarget();
    if (!s || s.crumbs.length < 2) return;
    const n = s.crumbs.length;
    cropKeep = [0, n - 1];
    const el = sheet(`<div class="msg">✂ Crop ${s === session ? 'this' : 'last'} session</div>
      <div class="sub crop-info"></div>
      <label class="crop-l">Start<input type="range" class="c0" min="0" max="${n - 1}" value="0"></label>
      <label class="crop-l">End<input type="range" class="c1" min="0" max="${n - 1}" value="${n - 1}"></label>
      <div class="row"><button class="btn" data-c="cancel">Cancel</button><button class="btn on" data-c="apply">Crop</button></div>`);
    el.classList.add('bottom'); // keep the dots visible above the sheet while cropping
    m.fitBounds(L.latLngBounds(s.crumbs.map(c => toMap(c))), { paddingTopLeft: [30, 90], paddingBottomRight: [30, el.offsetHeight + 40], maxZoom: 1 });
    userMoved = true;
    const c0 = el.querySelector<HTMLInputElement>('.c0')!, c1 = el.querySelector<HTMLInputElement>('.c1')!;
    const update = () => {
      let a = +c0.value, b = +c1.value;
      if (a > b) [a, b] = [b, a];
      cropKeep = [a, b];
      const kept = s.crumbs.slice(a, b + 1);
      el.querySelector('.crop-info')!.textContent = `${timeOf(kept[0][2])} → ${timeOf(kept[kept.length - 1][2])} · keeps ${km(crumbsM(kept))} · ${kept.length} of ${n} dots`;
      drawDots();
    };
    c0.addEventListener('input', update);
    c1.addEventListener('input', update);
    update();
    el.addEventListener('click', e => {
      const a = (e.target as HTMLElement).dataset.c;
      if (!a) return;
      if (a === 'apply' && cropKeep) {
        s.crumbs = s.crumbs.slice(cropKeep[0], cropKeep[1] + 1);
        if (s.crumbs[0]) s.crumbs[0] = [s.crumbs[0][0], s.crumbs[0][1], s.crumbs[0][2]]; // no break before the first dot
        s.started = s.crumbs[0]?.[2] ?? s.started;
        if (s.ended) s.ended = s.crumbs[s.crumbs.length - 1]?.[2] ?? s.ended;
      }
      cropKeep = null;
      el.remove();
      changed();
    });
  };

  return () => {
    removeCompass();
    fix.remove();
    pill.remove();
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
