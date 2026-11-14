# NISAR radar windows

The radar data behind the map, cut down to what the pipeline needs. Keeping it
here means the map data in `web/data` can be rebuilt, and the processing
retuned, without downloading anything or logging in anywhere:

```bash
.venv/bin/python -m pipeline.run --all --offline
```

## What is in here

```
manifest.json                       which NASA products every window came from
<place>/<track and frame>/
  <first date>_<second date>.npz    one interferogram, cut to the place
  static.npz                        elevation (m) and land cover on the same grid
```

Each interferogram file holds the window of one NISAR L2 GUNW product
(geocoded unwrapped interferogram, 80 m pixels, UTM) over the place:

| Array | Type | Meaning |
| --- | --- | --- |
| `phase` | int16 | unwrapped phase minus `phase_offset`, in steps of 0.01 rad (0.2 mm of motion at L band). -32768 is missing |
| `coh` | uint8 | coherence in percent. 255 is missing |
| `cc` | uint16 | connected component labels from the unwrapper (0 is unreliable) |
| `flags` | uint8 | bit 0 water, bit 1 unusable sample |
| `iono` | float16 | ionosphere phase screen at one eighth resolution |
| `grid_*` | scalars | UTM zone (EPSG code), centre of the top left pixel, size |
| `meta_*` | scalars | wavelength, look and pass direction, incidence angle, acquisition times |

`pipeline/fetch.py` reads and writes this format (`load_cached`, `pack`,
`save_npz`). The files are ordinary numpy npz archives with LZMA compression,
so `numpy.load` opens them directly.

The originals are 2 GB each and can be fetched again from the Alaska Satellite
Facility using the product names in `manifest.json`. What is stored here is
rounded (phase to 0.01 rad, coherence to 1 percent), which is far below the
noise of the measurement.

## Sources and credit

* NISAR L2 GUNW provisional products, NASA and ISRO, distributed by the Alaska
  Satellite Facility DAAC. NASA data is free and open.
* Elevation in `static.npz`: Copernicus DEM GLO 90, ESA.
* Land cover in `static.npz`: ESA WorldCover 2021 (CC BY 4.0).
