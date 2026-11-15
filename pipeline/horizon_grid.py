"""Malla de horizontes y vectores del cielo para coordenadas personalizadas (B12, decisión A13).

El reto pide poder escribir coordenadas lunares propias. El sitio publicado no tiene servidor, así que se
precalcula aquí lo que el navegador no puede calcular:

1. **Malla de horizontes** (`web/public/data/horizon_grid/`): un punto cada GRID_SPACING_M en la proyección
   estereográfica polar del DEM, hasta GRID_LAT_LIMIT (85°S, la misma cobertura que el mapa de iluminación de
   Mazarico). En cada punto, la máscara de horizonte de 5.2 con el DEM LOLA de 40 m, con la misma función que
   los sitios (`horizon.compute_mask`): 360 azimuts, R_max 100 km, h_obs 3 m, sin recorte a 0.
   El navegador usa la máscara del punto de la malla más cercano a la coordenada y dice a qué distancia está.

2. **Vectores del cielo** (`web/public/data/sky/`): posición del Sol y de la Tierra respecto al centro de la
   Luna en MOON_ME, con LT+S, cada STEP_MIN en todo el rango de las series. Con ellos el navegador calcula el
   azimut y la elevación desde cualquier punto (resta la posición del observador y pasa a ENU), como
   `ephemeris.target_enu_km`. La diferencia frente a calcular LT+S desde el propio sitio es de milisegundos de
   tiempo de luz y fracciones de segundo de arco (se mide en las pruebas del front end contra las series).

Uso:
    python -m pipeline.horizon_grid            # las dos cosas
    python -m pipeline.horizon_grid --sky      # solo los vectores (no necesita el DEM)
    python -m pipeline.horizon_grid --grid     # solo la malla (no necesita los kernels)
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np

from pipeline import config

ROOT = Path(__file__).resolve().parents[1]
OUT_DATA = ROOT / "web" / "public" / "data"
GRID_DIR = OUT_DATA / "horizon_grid"
SKY_DIR = OUT_DATA / "sky"
CACHE = Path(__file__).with_name("out") / "horizon_grid_dem.npy"

GRID_SPACING_M = 5_000.0
GRID_LAT_LIMIT = -85.0
MASK_SCALE = 0.01  # int16 en centésimas de grado
MASK_NODATA = -32768


def grid_layout(spacing_m: float = GRID_SPACING_M, lat_limit: float = GRID_LAT_LIMIT) -> dict:
    """Rejilla cuadrada centrada en el polo; `inside[j, i]` marca los puntos con latitud ≤ lat_limit.

    Fila j = 0 arriba (y máxima), columna i = 0 a la izquierda (x mínima), como el DEM y `terrain/_polar`.
    """
    from pipeline.dem import latlon_to_xy

    x_lim, y_lim = latlon_to_xy(lat_limit, 0.0)
    r_max = float(np.hypot(x_lim, y_lim))
    half = int(np.floor(r_max / spacing_m))
    n = 2 * half + 1
    coords = (np.arange(n) - half) * spacing_m
    xs = coords
    ys = coords[::-1]
    X, Y = np.meshgrid(xs, ys)
    inside = np.hypot(X, Y) <= r_max + 1e-6
    return {"n": n, "half": half, "spacing_m": spacing_m, "r_max_m": r_max, "x0_m": float(xs[0]), "y0_m": float(ys[0]),
            "X": X, "Y": Y, "inside": inside}


# ---------------------------------------------------------------- malla (procesos en paralelo)

_WINDOW = None


def _init_worker(cache_path: str, transform_vals: list[float]) -> None:
    global _WINDOW
    from affine import Affine

    from pipeline.dem import DemWindow

    z = np.load(cache_path, mmap_mode="r")
    _WINDOW = DemWindow(z, Affine(*transform_vals))


def _mask_at(args: tuple[int, float, float]) -> tuple[int, float, np.ndarray]:
    from pipeline.dem import xy_to_latlon
    from pipeline.horizon import compute_mask

    k, x, y = args
    lat, lon = xy_to_latlon(x, y)
    lat, lon = float(lat), float(lon)
    z0 = float(_WINDOW.sample(np.array([x]), np.array([y]))[0])
    return k, z0, compute_mask(_WINDOW, lat, lon, z0)


def build_grid(workers: int | None = None, limit: int | None = None) -> dict:
    """Calcula todas las máscaras de la malla. `limit` (pruebas de tiempo): solo los primeros N puntos."""
    from multiprocessing import Pool

    from pipeline.dem import DemWindow

    g = grid_layout()
    half_m = g["r_max_m"] + config.HORIZON_R_MAX_KM * 1000.0 + 2_000.0
    t0 = time.perf_counter()
    if not CACHE.exists():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        w = DemWindow.read(0.0, 0.0, half_m)
        np.save(CACHE, w.z)
        CACHE.with_suffix(".json").write_text(json.dumps(list(w.transform)[:6]))
        del w
    transform_vals = json.loads(CACHE.with_suffix(".json").read_text())
    print(f"DEM en caché ({CACHE.name}) en {time.perf_counter() - t0:.1f} s", flush=True)

    idx = np.flatnonzero(g["inside"].ravel())
    if limit:
        idx = idx[:limit]
    jobs = [(int(k), float(g["X"].ravel()[k]), float(g["Y"].ravel()[k])) for k in idx]
    n_az = int(round(360.0 / config.HORIZON_AZ_STEP_DEG))
    masks = np.full((g["n"] * g["n"], n_az), np.nan)
    z0 = np.full(g["n"] * g["n"], np.nan)
    workers = workers or max(1, (os.cpu_count() or 2) - 1)
    t1 = time.perf_counter()
    with Pool(workers, initializer=_init_worker, initargs=(str(CACHE), transform_vals)) as pool:
        for done, (k, z, m) in enumerate(pool.imap_unordered(_mask_at, jobs, chunksize=4), 1):
            masks[k], z0[k] = m, z
            if done % 200 == 0 or done == len(jobs):
                el = time.perf_counter() - t1
                print(f"  {done}/{len(jobs)} puntos · {el:.0f} s · faltan ~{el / done * (len(jobs) - done):.0f} s", flush=True)
    return {"layout": g, "masks": masks, "z0": z0, "n_az": n_az, "points": len(jobs)}


def write_grid(res: dict) -> list[Path]:
    g = res["layout"]
    GRID_DIR.mkdir(parents=True, exist_ok=True)
    m = res["masks"]
    q = np.where(np.isnan(m), MASK_NODATA, np.round(m / MASK_SCALE)).astype("<i2")
    bin_path = GRID_DIR / "masks.bin"
    bin_path.write_bytes(q.tobytes())
    z0 = [None if np.isnan(v) else round(float(v), 1) for v in res["z0"]]
    header = {
        "product": "Horizon masks on a polar grid (spec 5.2), for custom coordinates",
        "dem_product": "LDEM_80S_40MPP_ADJ.TIF (LRO LOLA, 40 m/pixel; Barker et al. 2023, doi:10.3847/PSJ/acf3e1)",
        "projection": "+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs",
        "grid": {"nx": g["n"], "ny": g["n"], "spacing_m": g["spacing_m"], "x0_m": g["x0_m"], "y0_m": g["y0_m"],
                 "lat_limit_deg": GRID_LAT_LIMIT, "r_max_m": round(g["r_max_m"], 1),
                 "order": "row-major from the top-left point (x0, y0); x grows with the column, y falls with the row"},
        "points": res["points"],
        "az_step_deg": config.HORIZON_AZ_STEP_DEG,
        "n_az": res["n_az"],
        "h_obs_m": config.H_OBS_M,
        "r_max_km": config.HORIZON_R_MAX_KM,
        "clip_negative": False,
        "encoding": {"dtype": "int16 little-endian", "scale_deg": MASK_SCALE, "nodata": MASK_NODATA,
                     "layout": "[point][azimuth], point = row * nx + column"},
        "bin_file": "masks.bin",
        "byte_length": bin_path.stat().st_size,
        "z0_m": z0,
    }
    json_path = GRID_DIR / "grid.json"
    json_path.write_text(json.dumps(header, separators=(",", ":")), encoding="utf-8")
    return [json_path, bin_path]


# ---------------------------------------------------------------- vectores del cielo

def build_sky(step_min: int = config.STEP_MIN) -> dict:
    """Sol y Tierra respecto al centro de la Luna, MOON_ME, LT+S (km), en la rejilla de las series."""
    import spiceypy as sp

    from pipeline.ephemeris import ABCORR, MOON_FRAME, et_grid

    start, end = config.timeseries_range()
    ets = et_grid(start, end, step_min)
    out = np.empty((len(ets), 6))
    for i, et in enumerate(ets):
        s, _ = sp.spkpos("SUN", float(et), MOON_FRAME, ABCORR, "MOON")
        e, _ = sp.spkpos("EARTH", float(et), MOON_FRAME, ABCORR, "MOON")
        out[i, :3], out[i, 3:] = s, e
    return {"start_utc": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "step_min": step_min, "n": len(ets), "vec": out}


def write_sky(sky: dict) -> list[Path]:
    SKY_DIR.mkdir(parents=True, exist_ok=True)
    bin_path = SKY_DIR / "moon_me.bin"
    bin_path.write_bytes(sky["vec"].astype("<f4").tobytes())
    header = {
        "product": "Sun and Earth positions relative to the Moon centre, for any observer on the surface",
        "frame": "MOON_ME", "abcorr": "LT+S", "observer": "MOON (centre)", "units": "km",
        "kernels": "de440s.bsp, moon_pa_de440_200625.bpc, moon_de440_250416.tf, pck00011.tpc, naif0012.tls (NAIF/JPL)",
        "start_utc": sky["start_utc"], "step_min": sky["step_min"], "n": sky["n"],
        "encoding": {"dtype": "float32 little-endian", "layout": "[sample][sun_x, sun_y, sun_z, earth_x, earth_y, earth_z]"},
        "bin_file": "moon_me.bin", "byte_length": bin_path.stat().st_size,
    }
    json_path = SKY_DIR / "sky.json"
    json_path.write_text(json.dumps(header, indent=1), encoding="utf-8")
    return [json_path, bin_path]


def main(argv=None) -> int:
    import argparse

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Malla de horizontes y vectores del cielo (coordenadas personalizadas)")
    ap.add_argument("--grid", action="store_true", help="solo la malla de horizontes")
    ap.add_argument("--sky", action="store_true", help="solo los vectores del Sol y la Tierra")
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--limit", type=int, default=None, help="solo los primeros N puntos (medir tiempos); no escribe")
    args = ap.parse_args(argv)
    both = not args.grid and not args.sky
    if args.sky or both:
        t = time.perf_counter()
        paths = write_sky(build_sky())
        print(f"cielo: {', '.join(p.name for p in paths)} en {time.perf_counter() - t:.1f} s")
    if args.grid or both:
        t = time.perf_counter()
        res = build_grid(args.workers, args.limit)
        if args.limit:
            print(f"malla (prueba de {res['points']} puntos) en {time.perf_counter() - t:.1f} s; no se escribe")
            return 0
        paths = write_grid(res)
        m = res["masks"][~np.isnan(res["masks"][:, 0])]
        print(f"malla: {res['points']} puntos, máscaras en [{m.min():+.2f}, {m.max():+.2f}]°, "
              f"{', '.join(f'{p.name} {p.stat().st_size / 1e6:.2f} MB' for p in paths)} en {time.perf_counter() - t:.1f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
