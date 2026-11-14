import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { MONTHS, buildField, monthLabel, stepKey } from "./synthetic";

// Centre of California, zoomed so the whole state is visible on the globe.
const CALIFORNIA_CENTER: [number, number] = [-119.5, 37.2];

// Diverging scale (mm): red = subsidence, gray = no change, blue = uplift.
const LIMIT = 100;
const COLOR_STOPS: [number, string][] = [
  [-LIMIT, "#b2182b"],
  [-LIMIT / 2, "#ef8a62"],
  [0, "#f0efec"],
  [LIMIT / 2, "#67a9cf"],
  [LIMIT, "#2166ac"],
];

function fillColor(step: number): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["get", stepKey(step)],
    ...COLOR_STOPS.flat(),
  ] as maplibregl.ExpressionSpecification;
}

const LEGEND_GRADIENT = `linear-gradient(to right, ${COLOR_STOPS.map(([, c]) => c).join(", ")})`;

export default function App() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [step, setStep] = useState(MONTHS);
  const [playing, setPlaying] = useState(false);
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    let cancelled = false;
    let map: maplibregl.Map | undefined;

    fetch("/data/california.geojson")
      .then((r) => r.json())
      .then((state: FeatureCollection) => {
        if (cancelled) return;
        const field = buildField(state);

        map = new maplibregl.Map({
          container: container.current!,
          style: "https://demotiles.maplibre.org/style.json",
          center: CALIFORNIA_CENTER,
          zoom: 4.8,
        });
        mapRef.current = map;

        map.on("style.load", () => map!.setProjection({ type: "globe" }));

        map.on("load", () => {
          map!.addSource("california", { type: "geojson", data: state });
          map!.addSource("subsidence", { type: "geojson", data: field });
          map!.addLayer({
            id: "subsidence-fill",
            type: "fill",
            source: "subsidence",
            paint: {
              "fill-color": fillColor(stepRef.current),
              "fill-opacity": 0.85,
              "fill-antialias": false,
            },
          });
          map!.addLayer({
            id: "california-outline",
            type: "line",
            source: "california",
            paint: { "line-color": "#f59e0b", "line-width": 4 },
          });

          const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
          map!.on("mousemove", "subsidence-fill", (e) => {
            const p = e.features?.[0]?.properties;
            if (!p) return;
            const v = p[stepKey(stepRef.current)] as number;
            popup
              .setLngLat(e.lngLat)
              .setHTML(
                `<strong>${v > 0 ? "+" : ""}${v} mm</strong><br/>since ${monthLabel(0)}<br/>trend ${p.rate} mm/month`,
              )
              .addTo(map!);
            map!.getCanvas().style.cursor = "crosshair";
          });
          map!.on("mouseleave", "subsidence-fill", () => {
            popup.remove();
            map!.getCanvas().style.cursor = "";
          });
        });
      });

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Repaint when the slider moves.
  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("subsidence-fill")) map.setPaintProperty("subsidence-fill", "fill-color", fillColor(step));
  }, [step]);

  // Auto-play through the months, looping back to the baseline.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setStep((s) => (s >= MONTHS ? 0 : s + 1)), 700);
    return () => clearInterval(id);
  }, [playing]);

  return (
    <div className="app">
      <header className="header">
        <h1>NISAR Subsidence — California</h1>
        <p>Synthetic demo data. NISAR data layer not connected yet.</p>
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
              max={MONTHS}
              step={1}
              value={step}
              onChange={(e) => {
                setPlaying(false);
                setStep(Number(e.target.value));
              }}
              aria-label="Month"
            />
            <span className="date">{monthLabel(step)}</span>
          </div>
          <div className="legend">
            <div className="legend-title">Vertical displacement since {monthLabel(0)} (mm)</div>
            <div className="legend-bar" style={{ background: LEGEND_GRADIENT }} />
            <div className="legend-labels">
              <span>−{LIMIT} sinking</span>
              <span>0</span>
              <span>+{LIMIT} rising</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
