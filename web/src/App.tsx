import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { MONTHS, SYNTHETIC_LIMIT, buildField, monthLabel, stepKey } from "./synthetic";
import { Cube, Dataset, ManifestEntry, cubeValue, loadDataset, loadManifest, renderStep } from "./nisar";
import { colorStops } from "./colors";

// Centre of California, zoomed so the whole state is visible on the globe.
const CALIFORNIA_CENTER: [number, number] = [-119.5, 37.2];

type Mode = "measured" | "trend";
type Source = { kind: "loading" } | { kind: "nisar"; ds: Dataset } | { kind: "synthetic" };

function syntheticFill(step: number): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["get", stepKey(step)],
    ...colorStops(SYNTHETIC_LIMIT).flat(),
  ] as maplibregl.ExpressionSpecification;
}

const formatDate = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });

const corners = (c: Cube): [[number, number], [number, number], [number, number], [number, number]] => {
  const [w, s, e, n] = c.meta.bounds;
  return [[w, n], [e, n], [e, s], [w, s]];
};

export default function App() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const datasets = useRef(new Map<string, Dataset>());
  const imageUrls = useRef<{ cube: Cube | null; urls: string[] }>({ cube: null, urls: [] });
  const [manifest, setManifest] = useState<ManifestEntry[]>([]);
  const [source, setSource] = useState<Source>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("measured");
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const stepRef = useRef(step);
  stepRef.current = step;

  const ds = source.kind === "nisar" ? source.ds : null;
  const cube = ds ? (mode === "trend" && ds.trend ? ds.trend : ds.measured) : null;
  const cubeRef = useRef<Cube | null>(null);
  cubeRef.current = cube;

  const lastStep = cube ? cube.meta.steps - 1 : MONTHS;
  const limit = ds ? ds.limit : SYNTHETIC_LIMIT;
  const stepLabel = (s: number) => (cube ? formatDate(cube.meta.dates[s]) : monthLabel(s));
  const baseline = cube ? formatDate(cube.meta.dates[0]) : monthLabel(0);

  // Create the map once; show the first dataset (or synthetic data if none exist).
  useEffect(() => {
    let cancelled = false;
    let map: maplibregl.Map | undefined;

    (async () => {
      const [state, entries]: [FeatureCollection, ManifestEntry[]] = await Promise.all([
        fetch("/data/california.geojson").then((r) => r.json()),
        loadManifest(),
      ]);
      const first = entries.length ? await loadDataset(entries[0]) : null;
      if (cancelled) return;
      if (first) datasets.current.set(first.entry.id, first);
      setManifest(entries);
      const last = first ? first.measured.meta.steps - 1 : MONTHS;
      stepRef.current = last;
      setSource(first ? { kind: "nisar", ds: first } : { kind: "synthetic" });
      setStep(last);

      const [w, s, e, n] = first?.measured.meta.bounds ?? [0, 0, 0, 0];
      map = new maplibregl.Map({
        container: container.current!,
        style: "https://demotiles.maplibre.org/style.json",
        center: first ? [(w + e) / 2, (s + n) / 2] : CALIFORNIA_CENTER,
        zoom: first ? 6.2 : 4.8,
      });
      mapRef.current = map;
      map.on("style.load", () => map!.setProjection({ type: "globe" }));

      map.on("load", () => {
        map!.addSource("california", { type: "geojson", data: state });
        const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

        if (first) {
          const c = first.measured;
          imageUrls.current = { cube: c, urls: [] };
          const url = (imageUrls.current.urls[last] = renderStep(c, last, first.limit));
          map!.addSource("nisar", { type: "image", url, coordinates: corners(c) });
          map!.addLayer({
            id: "nisar-raster",
            type: "raster",
            source: "nisar",
            paint: { "raster-fade-duration": 0, "raster-resampling": "linear" },
          });
          map!.on("mousemove", (ev) => {
            const cur = cubeRef.current;
            const v = cur && cubeValue(cur, stepRef.current, ev.lngLat.lng, ev.lngLat.lat);
            if (!cur || v === null || v === undefined) return popup.remove();
            popup
              .setLngLat(ev.lngLat)
              .setHTML(`<strong>${v > 0 ? "+" : ""}${v.toFixed(0)} mm</strong><br/>since ${formatDate(cur.meta.dates[0])}`)
              .addTo(map!);
          });
          map!.on("mouseout", () => popup.remove());
        } else {
          map!.addSource("subsidence", { type: "geojson", data: buildField(state) });
          map!.addLayer({
            id: "subsidence-fill",
            type: "fill",
            source: "subsidence",
            paint: { "fill-color": syntheticFill(last), "fill-opacity": 0.85, "fill-antialias": false },
          });
          map!.on("mousemove", "subsidence-fill", (ev) => {
            const p = ev.features?.[0]?.properties;
            if (!p) return;
            const v = p[stepKey(stepRef.current)] as number;
            popup
              .setLngLat(ev.lngLat)
              .setHTML(`<strong>${v > 0 ? "+" : ""}${v} mm</strong><br/>since ${monthLabel(0)}<br/>trend ${p.rate} mm/month`)
              .addTo(map!);
          });
          map!.on("mouseleave", "subsidence-fill", () => popup.remove());
        }

        map!.addLayer({
          id: "california-outline",
          type: "line",
          source: "california",
          paint: { "line-color": "#f59e0b", "line-width": 3 },
        });
      });
    })();

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Switch track: load (once) and show the dataset, jumping to its last step.
  const selectDataset = async (entry: ManifestEntry) => {
    let next = datasets.current.get(entry.id);
    if (!next) {
      const loaded = await loadDataset(entry);
      if (!loaded) return;
      datasets.current.set(entry.id, loaded);
      next = loaded;
    }
    setPlaying(false);
    setSource({ kind: "nisar", ds: next });
    setStep(next.measured.meta.steps - 1);
  };

  // Repaint when the slider, track or measured/trend mode changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (cube && ds) {
      const image = map.getSource("nisar") as maplibregl.ImageSource | undefined;
      if (imageUrls.current.cube !== cube) imageUrls.current = { cube, urls: [] };
      const st = Math.min(step, cube.meta.steps - 1);
      const url = (imageUrls.current.urls[st] ??= renderStep(cube, st, ds.limit));
      image?.updateImage({ url, coordinates: corners(cube) });
    } else if (map.getLayer("subsidence-fill")) {
      map.setPaintProperty("subsidence-fill", "fill-color", syntheticFill(step));
    }
  }, [step, cube, ds]);

  // Auto-play through the time steps, looping back to the baseline.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setStep((s) => (s >= lastStep ? 0 : s + 1)), 700);
    return () => clearInterval(id);
  }, [playing, lastStep]);

  const gradient = `linear-gradient(to right, ${colorStops(limit).map(([, c]) => c).join(", ")})`;
  const meta = cube?.meta;
  const shownStep = Math.min(step, lastStep);

  return (
    <div className="app">
      <header className="header">
        <h1>NISAR Subsidence — {meta ? "Tulare Basin, California" : "California"}</h1>
        <p>
          {source.kind === "loading" && "Loading…"}
          {meta &&
            `NISAR L2 GUNW, ${meta.label}, ${meta.source.pairs.length} pairs, ` +
            `${formatDate(meta.dates[0])} – ${formatDate(meta.dates[meta.dates.length - 1])}. ` +
            `Experimental. Motion is relative: zero is the area's typical level, not an absolute reference.`}
          {source.kind === "synthetic" && "Synthetic demo data (no NISAR cube found — run scripts/build_subsidence.py)."}
        </p>
      </header>
      <div className="map-wrap">
        <div className="map" ref={container} />
        <section className="panel">
          {ds && (
            <div className="panel-row options">
              <select
                value={ds.entry.id}
                onChange={(e) => selectDataset(manifest.find((m) => m.id === e.target.value)!)}
                aria-label="Dataset"
              >
                {manifest.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              {ds.trend && (
                <div className="toggle" role="group" aria-label="Display">
                  <button className={mode === "measured" ? "on" : ""} onClick={() => setMode("measured")}>Measured</button>
                  <button className={mode === "trend" ? "on" : ""} onClick={() => setMode("trend")}>Trend</button>
                </div>
              )}
            </div>
          )}
          <div className="panel-row">
            <button className="play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "❚❚" : "▶"}
            </button>
            <input
              type="range"
              min={0}
              max={lastStep}
              step={1}
              value={shownStep}
              onChange={(e) => {
                setPlaying(false);
                setStep(Number(e.target.value));
              }}
              aria-label="Time step"
            />
            <span className="date">{stepLabel(shownStep)}</span>
          </div>
          <div className="legend">
            <div className="legend-title">
              {cube ? (mode === "trend" ? "Steady-rate vertical displacement" : "Vertical displacement") : "Displacement"} since{" "}
              {baseline} (mm)
            </div>
            <div className="legend-bar" style={{ background: gradient }} />
            <div className="legend-labels">
              <span>−{limit} sinking</span>
              <span>0</span>
              <span>+{limit} rising</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
