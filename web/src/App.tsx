import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// Centre of California, zoomed so the whole state is visible on the globe.
const CALIFORNIA_CENTER: [number, number] = [-119.5, 37.2];

export default function App() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: "https://demotiles.maplibre.org/style.json",
      center: CALIFORNIA_CENTER,
      zoom: 4.8,
    });

    map.on("style.load", () => {
      map.setProjection({ type: "globe" });
    });

    map.on("load", () => {
      map.addSource("california", { type: "geojson", data: "/data/california.geojson" });
      map.addLayer({
        id: "california-fill",
        type: "fill",
        source: "california",
        paint: { "fill-color": "#f59e0b", "fill-opacity": 0.2 },
      });
      map.addLayer({
        id: "california-outline",
        type: "line",
        source: "california",
        paint: { "line-color": "#f59e0b", "line-width": 4 },
      });
    });

    return () => map.remove();
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>NISAR Subsidence — California</h1>
        <p>3D globe view. NISAR data layer not connected yet.</p>
      </header>
      <div className="map" ref={container} />
    </div>
  );
}
