"""B12: malla de horizontes para coordenadas personalizadas (sin DEM: geometría y codificación)."""

import json

import numpy as np

from pipeline import horizon_grid as hg
from pipeline.dem import latlon_to_xy, xy_to_latlon


def test_layout_covers_85s_with_5_km_spacing():
    g = hg.grid_layout()
    x, y = latlon_to_xy(-85.0, 0.0)
    assert abs(g["r_max_m"] - np.hypot(x, y)) < 1e-6
    assert g["n"] % 2 == 1 and g["X"][g["half"], g["half"]] == 0 and g["Y"][g["half"], g["half"]] == 0
    assert np.allclose(np.diff(g["X"][0]), 5_000.0) and np.allclose(np.diff(g["Y"][:, 0]), -5_000.0)
    lat, _ = xy_to_latlon(g["X"][g["inside"]], g["Y"][g["inside"]])
    assert np.all(np.asarray(lat) <= -85.0 + 1e-9)
    # el círculo de 151.7 km a 5 km de paso tiene unos π·r²/25 km² puntos
    assert abs(g["inside"].sum() - np.pi * (g["r_max_m"] / 5_000.0) ** 2) < 0.02 * g["inside"].sum()


def test_write_grid_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(hg, "GRID_DIR", tmp_path)
    g = hg.grid_layout(spacing_m=50_000.0)
    n = g["n"] * g["n"]
    masks = np.full((n, 360), np.nan)
    z0 = np.full(n, np.nan)
    k = int(np.flatnonzero(g["inside"].ravel())[0])
    masks[k] = np.linspace(-2.5, 3.21, 360)
    z0[k] = 1234.56
    paths = hg.write_grid({"layout": g, "masks": masks, "z0": z0, "n_az": 360, "points": 1})
    header = json.loads(paths[0].read_text(encoding="utf-8"))
    q = np.frombuffer(paths[1].read_bytes(), dtype="<i2").reshape(n, 360)
    assert header["byte_length"] == paths[1].stat().st_size
    assert np.allclose(q[k] * header["encoding"]["scale_deg"], masks[k], atol=0.005)
    assert (np.delete(q, k, axis=0) == header["encoding"]["nodata"]).all()
    assert header["z0_m"][k] == 1234.6 and header["z0_m"].count(None) == n - 1
