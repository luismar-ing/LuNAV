"""Datos para coordenadas personalizadas (B12, decisión A13).

El reto pide poder escribir coordenadas lunares propias. El sitio publicado no tiene servidor: aquí se precalcula
lo que el navegador necesita para hacer el cálculo él mismo en cualquier punto entre 85°S y el polo.

1. **Vectores del cielo** (`web/public/data/sky/`): posición del Sol y de la Tierra respecto al centro de la Luna
   en MOON_ME, con LT+S, cada STEP_MIN en todo el rango de las series. El navegador resta la posición del
   observador y pasa a ENU, como `ephemeris.target_enu_km`.

2. **Relieve reducido** (`web/public/data/terrain_custom/`): el DEM LOLA de 40 m promediado por bloques en dos
   niveles. El navegador traza los 360 rayos de la máscara de 5.2 desde la coordenada exacta:
   - FINE_M (160 m) hasta NEAR_M (10 km) del punto, donde el detalle del terreno decide;
   - COARSE_M (400 m) de NEAR_M a R_max (100 km).
   Medido en los cinco sitios frente a sus máscaras de 40 m (docs, PROGRESS B12): ampliar el tramo fino a 25 km
   no cambia nada; afinar a 120 m mejora poco y pesaría el doble.
   El cálculo de referencia en Python (`hybrid_mask`) se guarda para los cinco sitios en
   `web/tests/fixtures/custom_site_masks.json`: el front end debe dar las mismas máscaras.

Uso:
    python -m pipeline.custom_site             # las dos cosas
    python -m pipeline.custom_site --sky       # solo los vectores (kernels SPICE)
    python -m pipeline.custom_site --terrain   # solo el relieve y la referencia (DEM LOLA de 40 m)
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

from pipeline import config

ROOT = Path(__file__).resolve().parents[1]
OUT_DATA = ROOT / "web" / "public" / "data"
SKY_DIR = OUT_DATA / "sky"
TERRAIN_DIR = OUT_DATA / "terrain_custom"
FIXTURE = ROOT / "web" / "tests" / "fixtures" / "custom_site_masks.json"

LAT_LIMIT = -85.0
FINE_FACTOR = 4  # 4 × 40 m = 160 m
COARSE_FACTOR = 10  # 10 × 40 m = 400 m
NEAR_M = 10_000.0
HEIGHT_SCALE_M = 0.5
NODATA = -32768


def limit_radius_m(lat_limit: float = LAT_LIMIT) -> float:
    from pipeline.dem import latlon_to_xy

    x, y = latlon_to_xy(lat_limit, 0.0)
    return float(np.hypot(x, y))


# ---------------------------------------------------------------- relieve reducido

class Level:
    """Un nivel del relieve reducido: alturas (m) en una rejilla cuadrada centrada en el polo."""

    def __init__(self, z: np.ndarray, x0: float, y0: float, res: float):
        self.z, self.x0, self.y0, self.res = np.asarray(z, dtype=np.float64), x0, y0, res

    def sample(self, x, y) -> np.ndarray:
        """Bilineal sobre centros de píxel; NaN fuera (igual que `dem.DemWindow.sample` y que el front end)."""
        col = (np.asarray(x, dtype=float) - self.x0) / self.res - 0.5
        row = (self.y0 - np.asarray(y, dtype=float)) / self.res - 0.5
        c0, r0 = np.floor(col).astype(np.int64), np.floor(row).astype(np.int64)
        fc, fr = col - c0, row - r0
        ny, nx = self.z.shape
        ok = (c0 >= 0) & (r0 >= 0) & (c0 + 1 < nx) & (r0 + 1 < ny)
        c0c, r0c = np.clip(c0, 0, nx - 2), np.clip(r0, 0, ny - 2)
        z = self.z
        out = (z[r0c, c0c] * (1 - fc) * (1 - fr) + z[r0c, c0c + 1] * fc * (1 - fr)
               + z[r0c + 1, c0c] * (1 - fc) * fr + z[r0c + 1, c0c + 1] * fc * fr)
        return np.where(ok, out, np.nan)


def block_mean(z: np.ndarray, f: int) -> np.ndarray:
    n0, n1 = (z.shape[0] // f) * f, (z.shape[1] // f) * f
    return np.asarray(z[:n0, :n1], dtype=np.float64).reshape(n0 // f, f, n1 // f, f).mean(axis=(1, 3))


def build_levels() -> tuple[Level, Level]:
    """Lee el DEM de 40 m alrededor del polo y devuelve los niveles fino y grueso (cuadrados centrados en 0, 0)."""
    from pipeline.dem import DemWindow

    r_lim = limit_radius_m()
    half_coarse = r_lim + config.HORIZON_R_MAX_KM * 1000.0 + 2 * COARSE_FACTOR * 40.0
    half_fine = r_lim + NEAR_M + 2 * FINE_FACTOR * 40.0
    w = DemWindow.read(0.0, 0.0, half_coarse + COARSE_FACTOR * 40.0)
    if np.isnan(w.z).any():
        raise ValueError("el DEM tiene huecos en la zona de 85°S + 100 km")
    t = w.transform

    def level(f: int, half: float) -> Level:
        # bloques alineados con la rejilla de 40 m y simétricos respecto al polo
        res = t.a * f
        n = int(np.ceil(half / res))  # half already carries a margin of two pixels of the level
        c_lo = int(round((-n * res - t.c) / t.a))
        r_lo = int(round((t.f - n * res) / t.a))
        if c_lo < 0 or r_lo < 0:
            raise ValueError("la ventana del DEM no cubre el nivel")
        z = block_mean(w.z[r_lo:r_lo + 2 * n * f, c_lo:c_lo + 2 * n * f], f)
        return Level(z, t.c + c_lo * t.a, t.f - r_lo * t.a, res)

    return level(FINE_FACTOR, half_fine), level(COARSE_FACTOR, half_coarse)


def hybrid_mask(fine: Level, coarse: Level, lat: float, lon: float, h_obs_m: float = config.H_OBS_M) -> tuple[np.ndarray, float]:
    """Máscara de 5.2 desde (lat, lon): nivel fino hasta NEAR_M, grueso hasta R_max. Devuelve (elev_deg, z0)."""
    from pipeline.dem import R_MOON_M, latlon_to_xy, ray_points_xy

    x, y = latlon_to_xy(lat, lon)
    z0 = float(fine.sample(np.array([x]), np.array([y]))[0])
    az = np.arange(0.0, 360.0, config.HORIZON_AZ_STEP_DEG)
    out = np.full(az.size, -90.0)
    r_max = config.HORIZON_R_MAX_KM * 1000.0
    for lv, d in ((fine, np.arange(1, int(NEAR_M / fine.res) + 1) * fine.res),
                  (coarse, NEAR_M + np.arange(1, int((r_max - NEAR_M) / coarse.res) + 1) * coarse.res)):
        X, Y = ray_points_xy(lat, lon, az, d)
        z = lv.sample(X, Y)
        if np.isnan(z).any():
            raise ValueError(f"({lat}, {lon}): el relieve reducido no cubre el rayo")
        el = np.degrees(np.arctan2(z - z0 - h_obs_m - d**2 / (2 * R_MOON_M), d[None, :]))
        out = np.maximum(out, el.max(axis=1))
    return out, z0


def write_level(name: str, lv: Level) -> dict:
    q = np.round(lv.z / HEIGHT_SCALE_M)
    if np.abs(q).max() >= 32767:
        raise ValueError("alturas fuera del rango de int16")
    path = TERRAIN_DIR / f"{name}.bin"
    path.write_bytes(q.astype("<i2").tobytes())
    ny, nx = lv.z.shape
    return {"bin_file": path.name, "byte_length": path.stat().st_size, "nx": nx, "ny": ny, "spacing_m": lv.res,
            "x0_m": lv.x0, "y0_m": lv.y0}


def write_terrain(fine: Level, coarse: Level) -> list[Path]:
    TERRAIN_DIR.mkdir(parents=True, exist_ok=True)
    header = {
        "product": "LOLA elevation reduced by block mean, for horizon masks at custom coordinates (spec 5.2)",
        "dem_product": "LDEM_80S_40MPP_ADJ.TIF (LRO LOLA, 40 m/pixel; Barker et al. 2023, doi:10.3847/PSJ/acf3e1)",
        "projection": "+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs",
        "lat_limit_deg": LAT_LIMIT,
        "near_m": NEAR_M,
        "r_max_km": config.HORIZON_R_MAX_KM,
        "h_obs_m": config.H_OBS_M,
        "az_step_deg": config.HORIZON_AZ_STEP_DEG,
        "height_encoding": "int16 little-endian, row-major from the top-left pixel (x0, y0 = its outer corner)",
        "height_scale_m": HEIGHT_SCALE_M,
        "fine": write_level("fine", fine),
        "coarse": write_level("coarse", coarse),
    }
    path = TERRAIN_DIR / "terrain.json"
    path.write_text(json.dumps(header, indent=1), encoding="utf-8")
    return [path, TERRAIN_DIR / "fine.bin", TERRAIN_DIR / "coarse.bin"]


def write_fixture(fine: Level, coarse: Level) -> Path:
    """Máscaras de referencia de los cinco sitios con el relieve PUBLICADO (cuantizado a 0.5 m)."""
    q = lambda lv: Level(np.round(lv.z / HEIGHT_SCALE_M) * HEIGHT_SCALE_M, lv.x0, lv.y0, lv.res)  # noqa: E731
    fq, cq = q(fine), q(coarse)
    sites = json.loads((ROOT / "pipeline" / "sites.json").read_text(encoding="utf-8"))
    out = {}
    for s in sites:
        m, z0 = hybrid_mask(fq, cq, s["lat"], s["lon"])
        out[s["id"]] = {"lat": s["lat"], "lon": s["lon"], "z0_m": round(z0, 3), "elev_deg": [round(float(v), 4) for v in m]}
    FIXTURE.write_text(json.dumps(out, indent=1), encoding="utf-8")
    return FIXTURE


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
    ap = argparse.ArgumentParser(description="Datos para coordenadas personalizadas (vectores del cielo y relieve reducido)")
    ap.add_argument("--sky", action="store_true", help="solo los vectores del Sol y la Tierra")
    ap.add_argument("--terrain", action="store_true", help="solo el relieve reducido y la referencia de los sitios")
    args = ap.parse_args(argv)
    both = not args.sky and not args.terrain
    if args.sky or both:
        t = time.perf_counter()
        paths = write_sky(build_sky())
        print(f"cielo: {', '.join(p.name for p in paths)} en {time.perf_counter() - t:.1f} s")
    if args.terrain or both:
        t = time.perf_counter()
        fine, coarse = build_levels()
        paths = write_terrain(fine, coarse)
        fx = write_fixture(fine, coarse)
        print(f"relieve: fino {fine.z.shape} a {fine.res:.0f} m, grueso {coarse.z.shape} a {coarse.res:.0f} m; "
              f"{', '.join(f'{p.name} {p.stat().st_size / 1e6:.2f} MB' for p in paths)}; referencia {fx.name}; "
              f"{time.perf_counter() - t:.1f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
