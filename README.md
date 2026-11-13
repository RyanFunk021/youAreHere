# You Are Here

Put a live GPS dot on a photo of any trail map.

Take a picture of a trailhead board, a park brochure or a ski map. Match a few spots
on it to the same spots on satellite imagery. From then on the app shows where you
are *on that photo*, along with the trail you've walked.

**Status:** prototype. One map at a time, works with the screen on, needs signal to
load the page.

## Use it

1. Open <https://ryanfunk021.github.io/youAreHere/> on your phone.
2. Tap **Choose a map photo** (later: **New map**) and take or pick the photo.
3. **Calibrate.** Tap a spot on the photo (top), then the same spot on the satellite
   (bottom), then **Add pair**. Re-tap either side to adjust before adding. Do this
   for 4–6 well-spread spots. Trail junctions, road crossings,
   parking lots and creek bends work well. Under tree canopy, switch the satellite
   to **Map** or **Map overlay** to see the trails.
   - **Fit ±N m** is how well the points agree.
   - With 5+ points, a mis-tapped one turns red. Delete it with ✕.
4. **Navigate.** Allow location. ◎ re-centres on you.

Spread your points around the edges of the area you'll travel. A fit is reliable
between points and drifts outside them.

## Develop

```sh
npm install
npm run dev        # http://localhost:5173/youAreHere/
```

Phones only allow GPS on HTTPS pages, so to test GPS on a phone, push to `main`.
GitHub Actions then deploys to Pages. Calibration works over plain HTTP on the LAN
(`npm run dev -- --host`).

`src/georef.ts` holds all the math (affine fit, inverse, residuals, mis-tap
detection). It has no DOM or map-library dependencies.

## Maps and copyright

Most trail, club and resort maps are copyrighted. Load your own photos into the app,
but don't commit them to this repo (`private/` and image files are git-ignored).
US National Park Service maps are public domain.

## License

GPL-3.0. Imagery © Esri and contributors; map data © OpenStreetMap contributors.
