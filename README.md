# Sinking Ground

A global map of ground that is sinking, measured from orbit by the NASA and ISRO
radar satellite NISAR, with a time bar that lets you go back through what has
been measured and forward into what happens if it continues.

It answers three questions for each place:

1. **Where is the ground going down, and how fast?**
2. **Which built up areas and buildings sit on ground that is sinking unevenly**
   enough to crack or damage them, and when do they pass the limits?
3. **How sure are we?** Every place states the smallest rate the data can
   detect so far, and short records are marked as early results.

![Mexico City in 2050 if current rates continue](docs/mexico-city-2050.png)

## Run it

The app is a static site with no build step.

```bash
python3 -m http.server 8000 --directory web
```

Then open http://localhost:8000.

Pick a place on the globe or in the list, drag the time bar, and zoom in to
street level to see individual buildings. Click anywhere inside a place to read
the rate, how far that spot has sunk, and when it passes the damage limits.

A view can be shared by its address, for example
`#place=mexico-city&t=2040-01-01`.

To put it online, publish the `web` folder on any static host (GitHub Pages,
Netlify, an S3 bucket). The map tiles, building outlines and night lights are
loaded from public servers, so the visitor needs an internet connection.

## What you see

| Thing on screen | Meaning |
| --- | --- |
| Bubbles on the globe | One per place. Size and colour show how far the fastest zone has sunk at the date on the time bar. Hollow grey means nothing detected yet. |
| Time bar, solid part | Measured by NISAR. One step per radar pass, 12 days apart. |
| Time bar, dashed part | Projection to 2050 that assumes the measured rate simply continues. A scenario, not a forecast. |
| Blue layer | How far the ground has sunk since the first radar pass (log scale, 1 cm to 10 m). |
| Damage risk layer | The same ground coloured by risk class instead. |
| Buildings | Coloured by the risk class of the ground under them at the chosen date. |

### Why buildings change colour

A building that sinks evenly with its whole neighbourhood is usually fine
structurally (flooding and drainage are another matter). Damage comes from
uneven sinking. We measure that as **angular distortion**: the difference in
sinking between neighbouring ground divided by the distance between them. It
grows every year the ground keeps sinking unevenly.

| Class | Rule | Colour |
| --- | --- | --- |
| No sinking detected | below the detection threshold | grey |
| Sinking evenly | sinking detected, distortion below 1/500 | blue |
| Cracking possible | distortion past 1/500 | amber |
| Cracking likely | distortion past 1/300 | red |
| Structural damage likely | distortion past 1/150 | pink |

The limits are the classic ones from foundation engineering (Skempton and
MacDonald 1956, Bjerrum 1963). They are screening levels for neighbourhoods,
not a verdict on any single building.

## What the data shows so far

Built on 2026-11-14 from 64 places. Sinking is detected over at least
1 km² in 15 of them:

| Place | Fastest zone | Area sinking | Record | Smallest detectable rate |
| --- | --- | --- | --- | --- |
| Mexico City, Mexico | 26 cm per year | 383 km² | 11 months | 2.1 cm per year |
| Tehran Plain, Iran | 23 cm per year | 56 km² | 4 months (early) | 6.1 cm per year |
| Quetta, Pakistan | 18 cm per year | 49 km² | 4 months (early) | 6.1 cm per year |
| Mashhad, Iran | 18 cm per year | 108 km² | 4 months (early) | 6.1 cm per year |
| Toluca, Mexico | 16 cm per year | 9 km² | 11 months | 2.8 cm per year |
| Rafsanjan Plain, Iran | 16 cm per year | 22 km² | 4 months (early) | 6.1 cm per year |
| Central Valley (Corcoran), United States | 14 cm per year | 3 km² | 11 months | 5.9 cm per year |
| Abidjan, Côte d'Ivoire | 13 cm per year | 4 km² | 4 months (early) | 9.7 cm per year |
| Istanbul, Türkiye | 11 cm per year | 6 km² | 4 months (early) | 7.1 cm per year |
| Bandung, Indonesia | 11 cm per year | 16 km² | 4 months (early) | 6.1 cm per year |
| Delhi, India | 10 cm per year | 3 km² | 11 months | 2.3 cm per year |
| Shanghai, China | 8 cm per year | 2 km² | 4 months (early) | 6.8 cm per year |
| Celaya, Mexico | 8 cm per year | 5 km² | 11 months | 2.4 cm per year |
| Isfahan, Iran | 8 cm per year | 1 km² | 4 months (early) | 6.1 cm per year |
| Ahmedabad, India | 4 cm per year | 5 km² | 11 months | 2.2 cm per year |

"Early" means only about four months of radar passes. Those rates were
measured over a single season, so the yearly figure may change as the record
grows.

No sinking above the detection limit (yet) in the other 49 places, among
them Jakarta, Houston, New Orleans, New York and Venice, all known to sink more
slowly than a few months of data can reveal. Five places in `places.json`
(Willcox Basin, Larissa, Konya Basin, Kathmandu, Yangon) are skipped for now
because too little built up ground gave a stable radar signal.

![The globe in 2035 if current rates continue](docs/globe-2035.png)

## How the data is made

The `pipeline` folder turns raw NISAR products into the small files the map
loads. For each place in `pipeline/places.json` it does this:

1. **Search** NASA's catalogue (CMR) for NISAR Level 2 GUNW products
   (geocoded unwrapped interferograms) over the place. `search.py`
2. **Read only what is needed.** Each product is a 2 GB HDF5 file. We open it
   remotely, ask HDF5 where the chunks covering the place live, and download
   just those byte ranges: about 25 MB and 8 seconds per file. `fetch.py`
3. **Keep ground that can be trusted.** Radar phase over wetlands follows the
   water level, and over forest, grass and farmland it follows the moisture in
   plants and soil. So only built up and bare ground (ESA WorldCover) is
   analysed, and only pixels whose radar echo stays stable (coherence of 0.5
   or more). `landcover.py`
4. **Clean each interferogram.** Remove a plane and a term proportional to
   elevation (orbit errors and layered atmosphere), then remove the smooth
   atmosphere estimated from ground that is not moving. `process.py`
5. **Build the time series.** A small baseline style network inversion gives
   the ground position at every radar pass. Whatever is fast in time but
   smooth in space is treated as weather and removed.
6. **Combine two viewing directions** (ascending and descending tracks) when
   both cover the place. Motion is read as vertical.
7. **Detect sinking.** A pixel counts as sinking when its rate is beyond
   three times the map noise and beyond a seasonal allowance of 2 cm divided
   by the record length, on gentle terrain, in patches of at least a quarter
   of a square kilometre. Short records therefore have to clear a higher bar.
   The sinking also has to be sustained: each third of the record must show
   at least 30 percent of its share, which removes one off episodes such as
   a frozen winter.
8. **Measure uneven sinking** as the slope of the rate map (angular distortion
   per year), kept only where it is clearly above the noise.
9. **Export** a Web Mercator grid per place at 80 m: rate, distortion rate,
   flags, and the measured wiggle around the straight line at every pass.
   `export.py`

Checks made while building it:

* Mexico City comes out at 26 cm per year averaged over its fastest zone
  (29 at the peak) across a full year of passes, in line with the map NASA
  and JPL published in 2026 and with earlier studies.
* The two independent viewing directions over Mexico City agree to within
  about 1.5 cm per year, pixel by pixel.
* Places the literature reports as fast sinking come out fast here too
  (Tehran, Mashhad, Rafsanjan, Quetta, Delhi, Celaya, Bandung), and places
  known to sink slowly come out as not detected.
* Before the land cover and seasonal rules were added, forest around
  São Paulo, marsh around New Orleans and rice fields around Semarang all
  showed up as fast "sinking" while the built up land beside them read zero.
  They no longer do. That is why those rules exist.
* New York appeared to sink 6 cm in its first winter and then not at all.
  The sustained sinking rule removes that kind of episode.

### Where the data lives

| Folder | What | Size |
| --- | --- | --- |
| `web/data` | what the map loads: one small index and two files per place | 16 MB |
| `data/nisar` | the radar windows the map data is built from, plus elevation and land cover on the same grids, and a manifest of the NASA products they came from | 1.2 GB |

Both are in the repository. `data/nisar` is the downloaded radar data in a
compact form (see `data/nisar/README.md`), so nothing has to be fetched again
to rebuild or retune the map data.

### Rebuild from the repository (no download, no login)

```bash
python3 -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt
```

```bash
.venv/bin/python -m pipeline.run --all --offline
```

### Update or add places

Fetching new radar passes needs a free Earthdata Login token
(https://urs.earthdata.nasa.gov, Generate Token). Never commit it.

```bash
export EARTHDATA_TOKEN=paste_your_token_here
```

```bash
.venv/bin/python -m pipeline.run --place mexico-city
```

```bash
.venv/bin/python -m pipeline.run --all
```

To add a place, add an entry to `pipeline/places.json` (centre and box size in
km) and run it. A one off box also works:

```bash
.venv/bin/python -m pipeline.run --lat 19.4 --lon -99.05 --size 64 --id my-place --name "My Place"
```

New windows are added to `data/nisar`, so reruns only fetch radar passes that
are not there yet. Commit the new files along with the updated `web/data`. As
NISAR keeps flying, rerunning lengthens every record, lowers every detection
threshold, and turns early results into firm ones.

## What this cannot tell you

* **It is a screening map.** One radar pixel is 80 m wide. It describes
  neighbourhoods, not a single building's foundations.
* **Strain from before NISAR is not counted.** Distortion is counted from the
  first radar pass (late 2025 at the earliest). Ground that has been sinking
  unevenly for decades is in worse shape than shown.
* **Short records only see fast sinking.** Most places have about four months
  of passes so far, which only reveals sinking faster than roughly 6 cm per
  year. "No sinking detected" there means "nothing that fast", not "stable".
* **The projection is a straight line.** Real rates change with pumping,
  rainfall and regulation.
* **Farmland, grass, forest and wetland are blank** by design, including
  places where the ground under them truly is sinking.
* **Motion is read as vertical.** Sideways motion on slopes is not separated.
* **NISAR products used here are provisional** releases.
* **Building outlines are machine drawn** from aerial imagery. Some are missing
  or wrong, and heights are not known.

## Layout

```
data/nisar/          the radar windows, elevation, land cover and manifest
pipeline/            Python: NISAR products to map data
  places.json        the places to process
  run.py             command line entry point
  search.py          find products in NASA's catalogue
  fetch.py           remote partial reads of the HDF5 products, storage format
  process.py         interferograms to ground motion, detection, distortion
  dem.py             Copernicus elevation
  landcover.py       ESA WorldCover
  export.py          grids and files for the web app
  quicklook.py       small PNG previews for checking results by eye
web/                 the static site
  index.html
  css/style.css
  act.html           take action: report, letter, find the others
  action/            city files, translations and policy examples for that page
  js/act.js          the take action page
  js/app.js          map, layers, panels
  js/data.js         reading the per place grids
  js/timeline.js     the time bar
  js/config.js       colours, limits, formatting
  data/              output of the pipeline (index.json and two files per place)
  vendor/            MapLibre GL JS and PMTiles
```

## Take action

Seeing the problem is step zero. `web/act.html` turns a spot on the map into
something a person can use. It opens from the place panel or from the popup
after clicking a building.

| Step | What the person gets |
| --- | --- |
| 1. Get the proof | A one page report for their spot: the measured sinking, when the ground passes each damage limit, a picture of the buildings around them by risk class, counts of buildings within 250 or 500 m, and the honest limits of the data. It prints on one A4 page and has a link to share. |
| 2. Send it | A ready written letter, filled in with those numbers, asking for an inspection or for answers about groundwater pumping. It names the office responsible and the law that obliges a reply. Copy, email, print or download. |
| 3. Find the others | A link to the city's group, ways to pass the report on, a short guide to turning a few neighbours into a group, and four cities that stopped their sinking with what they did. |

Nothing the person types (name, address) leaves their device.

### Cities with a full local guide

For the ten places where the most built up land is projected to pass the
cracking limit, the responsible offices, their contact pages, the right to
information mechanism and the emergency number were looked up on official
pages: Mexico City, Mashhad, Tehran, Quetta, Toluca, Bandung, Delhi, Abidjan,
Shanghai and Istanbul. Every other place gets the report, a general letter and
general guidance on who is usually responsible.

Each city is one file, `web/action/cities/<place id>.json`, described in
`web/action/README.md`. Each contact carries the official page it was read
from and the date it was checked. **Contacts go stale and were gathered by
desk research, not by someone on the ground: a local person should check a
city's file before it is promoted there.** Fixing or adding a city is a change
to one JSON file, with no code.

### Groups

The idea is one group per city where neighbours organise. When a group exists,
add it to that city's file and the page shows a join button:

```json
"groups": [{ "platform": "telegram", "url": "https://t.me/your_group", "label": "Sinking Ground Mexico City" }]
```

Until then the page says there is no group yet and invites the reader to start
one. Each city file also records whether Telegram is reachable there and what
neighbourhood groups normally use, because that differs by country.

### Languages

Every sentence of the page and the letters lives in
`web/action/i18n/<language>.json`; `en.json` is the source. A language listed
in `web/action/i18n/index.json` appears in the language menu. The page opens in
the city's own language, and the letter is written in it. The examples of
cities that stopped their sinking are in `web/action/cases.json`, each with its
sources.

### For other features

The map announces what a person is looking at, so further features can plug in
without touching the map code:

```js
document.addEventListener('sinkingground:place', e => { /* e.detail: id, name, country, detected */ });
document.addEventListener('sinkingground:inspect', e => { /* e.detail: place, lng, lat, riskClass, rate_mm_per_year, sunk_mm, time, projected */ });
document.addEventListener('sinkingground:time', e => { /* e.detail: time, projected */ });
```

## Next steps

* Have local people check each city file and translation.
* Create the city groups and add their links.
* Collect crack reports from residents on the map (this needs a server and
  moderation, so it is not built).
* Rerun the pipeline as radar passes accumulate, add places, mosaic
  neighbouring radar frames for places that straddle two, and use the weather
  model layers shipped inside the products for a better atmosphere correction.

## Credits

* Ground motion: NISAR L2 GUNW, NASA and ISRO, distributed by the Alaska
  Satellite Facility DAAC.
* Elevation: Copernicus DEM GLO 90, ESA.
* Land cover: ESA WorldCover 2021.
* Night lights on the globe: NASA GIBS, VIIRS Black Marble.
* Buildings: Google Open Buildings, Microsoft Building Footprints and
  OpenStreetMap, merged by VIDA (source.coop).
* Base map: OpenFreeMap, OpenMapTiles, OpenStreetMap contributors.
* Map library: MapLibre GL JS. Tile archive reader: PMTiles.
