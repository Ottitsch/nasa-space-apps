import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { MONTHS, SYNTHETIC_LIMIT, buildField, monthLabel, stepKey } from "./synthetic";
import { Cube, cubeValue, loadCube, renderStep, suggestLimit } from "./nisar";
import { colorStops } from "./colors";

// Centre of California, zoomed so the whole state is visible on the globe.
const CALIFORNIA_CENTER: [number, number] = [-119.5, 37.2];

type Source = { kind: "loading" } | { kind: "nisar"; cube: Cube; limit: number } | { kind: "synthetic" };

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

export default function App() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const imageUrls = useRef<string[]>([]);
  const [source, setSource] = useState<Source>({ kind: "loading" });
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const stepRef = useRef(step);
  stepRef.current = step;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const lastStep = source.kind === "nisar" ? source.cube.meta.steps - 1 : MONTHS;
  const limit = source.kind === "nisar" ? source.limit : SYNTHETIC_LIMIT;
  const stepLabel = (s: number) =>
    source.kind === "nisar" ? formatDate(source.cube.meta.dates[s]) : monthLabel(s);
  const baseline = source.kind === "nisar" ? formatDate(source.cube.meta.dates[0]) : monthLabel(0);

  useEffect(() => {
    let cancelled = false;
    let map: maplibregl.Map | undefined;

    Promise.all([fetch("/data/california.geojson").then((r) => r.json()), loadCube()]).then(
      ([state, cube]: [FeatureCollection, Cube | null]) => {
        if (cancelled) return;
        const limit = cube ? suggestLimit(cube) : SYNTHETIC_LIMIT;
        const src: Source = cube ? { kind: "nisar", cube, limit } : { kind: "synthetic" };
        const last = cube ? cube.meta.steps - 1 : MONTHS;
        stepRef.current = last;
        setSource(src);
        setStep(last);

        const [w, s, e, n] = cube?.meta.bounds ?? [0, 0, 0, 0];
        map = new maplibregl.Map({
          container: container.current!,
          style: "https://demotiles.maplibre.org/style.json",
          center: cube ? [(w + e) / 2, (s + n) / 2] : CALIFORNIA_CENTER,
          zoom: cube ? 6.2 : 4.8,
        });
        mapRef.current = map;
        map.on("style.load", () => map!.setProjection({ type: "globe" }));

        map.on("load", () => {
          map!.addSource("california", { type: "geojson", data: state });
          const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

          if (cube) {
            imageUrls.current = [];
            const urlFor = (st: number) => (imageUrls.current[st] ??= renderStep(cube, st, limit));
            map!.addSource("nisar", {
              type: "image",
              url: urlFor(last),
              coordinates: [[w, n], [e, n], [e, s], [w, s]],
            });
            map!.addLayer({
              id: "nisar-raster",
              type: "raster",
              source: "nisar",
              paint: { "raster-fade-duration": 0, "raster-resampling": "linear" },
            });
            map!.on("mousemove", (ev) => {
              const v = cubeValue(cube, stepRef.current, ev.lngLat.lng, ev.lngLat.lat);
              if (v === null) return popup.remove();
              popup
                .setLngLat(ev.lngLat)
                .setHTML(`<strong>${v > 0 ? "+" : ""}${v.toFixed(0)} mm</strong><br/>since ${formatDate(cube.meta.dates[0])}`)
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
      },
    );

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Repaint when the slider moves.
  useEffect(() => {
    const map = mapRef.current;
    const src = sourceRef.current;
    if (!map) return;
    if (src.kind === "nisar") {
      const image = map.getSource("nisar") as maplibregl.ImageSource | undefined;
      const { cube, limit } = src;
      const url = (imageUrls.current[step] ??= renderStep(cube, step, limit));
      const [w, s, e, n] = cube.meta.bounds;
      image?.updateImage({ url, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
    } else if (map.getLayer("subsidence-fill")) {
      map.setPaintProperty("subsidence-fill", "fill-color", syntheticFill(step));
    }
  }, [step]);

  // Auto-play through the time steps, looping back to the baseline.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setStep((s) => (s >= lastStep ? 0 : s + 1)), 700);
    return () => clearInterval(id);
  }, [playing, lastStep]);

  const gradient = `linear-gradient(to right, ${colorStops(limit).map(([, c]) => c).join(", ")})`;
  const nisar = source.kind === "nisar" ? source.cube.meta : null;

  return (
    <div className="app">
      <header className="header">
        <h1>NISAR Subsidence — {nisar ? "Tulare Basin, California" : "California"}</h1>
        <p>
          {source.kind === "loading" && "Loading…"}
          {nisar &&
            `NISAR L2 GUNW, track ${nisar.source.track}${nisar.source.direction} frame ${nisar.source.frame}, ` +
            `${nisar.source.pairs.length} pairs, ${formatDate(nisar.dates[0])} – ${formatDate(nisar.dates[nisar.dates.length - 1])}. ` +
            `Experimental: atmosphere and ionosphere not corrected.`}
          {source.kind === "synthetic" && "Synthetic demo data (no NISAR cube found — run scripts/build_subsidence.py)."}
        </p>
      </header>
      <div className="map-wrap">
        <div className="map" ref={container} />
        <section className="panel">
          <div className="panel-row">
            <button className="play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "❚❚" : "▶"}
            </button>
            <input
              type="range"
              min={0}
              max={lastStep}
              step={1}
              value={Math.min(step, lastStep)}
              onChange={(e) => {
                setPlaying(false);
                setStep(Number(e.target.value));
              }}
              aria-label="Time step"
            />
            <span className="date">{stepLabel(Math.min(step, lastStep))}</span>
          </div>
          <div className="legend">
            <div className="legend-title">
              {nisar ? "Vertical displacement" : "Displacement"} since {baseline} (mm)
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
