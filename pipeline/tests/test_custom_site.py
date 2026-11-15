"""B12: datos para coordenadas personalizadas (sin DEM real: relieve sintético y codificación)."""

import json

import numpy as np

from pipeline import config
from pipeline import custom_site as cs
from pipeline.dem import R_MOON_M


def flat(res: float, half: float, z: float = 0.0) -> cs.Level:
    n = int(2 * half / res)
    return cs.Level(np.full((n, n), z), -half, half, res)


def test_block_mean_and_bilinear_sample():
    z = np.arange(16.0).reshape(4, 4)
    assert np.allclose(cs.block_mean(z, 2), [[2.5, 4.5], [10.5, 12.5]])
    lv = cs.Level(np.array([[0.0, 10.0], [20.0, 30.0]]), 0.0, 2.0, 1.0)
    # centros de píxel en (0.5, 1.5), (1.5, 1.5), (0.5, 0.5), (1.5, 0.5)
    assert np.isclose(lv.sample(np.array([1.0]), np.array([1.0]))[0], 15.0)
    assert np.isnan(lv.sample(np.array([5.0]), np.array([1.0]))[0])


def test_flat_ground_horizon_is_the_dip_of_the_sphere():
    """Terreno plano: el horizonte es el mismo en todos los azimuts, el máximo de −atan((h_obs + d²/2R) / d)."""
    fine, coarse = flat(160.0, 200_000.0), flat(400.0, 300_000.0)
    m, z0 = cs.hybrid_mask(fine, coarse, -89.0, 30.0)
    assert z0 == 0.0 and m.shape == (360,)
    d = np.concatenate([np.arange(1, 63) * 160.0, 10_000.0 + np.arange(1, 226) * 400.0])
    expected = np.degrees(np.arctan2(-config.H_OBS_M - d**2 / (2 * R_MOON_M), d)).max()
    assert np.allclose(m, expected, atol=1e-9)


def test_a_wall_beyond_10_km_is_seen_through_the_coarse_level():
    fine, coarse = flat(160.0, 200_000.0), flat(400.0, 300_000.0)
    yy = coarse.y0 - (np.arange(coarse.z.shape[0]) + 0.5) * coarse.res
    coarse.z[(yy > 20_000) & (yy < 30_000), :] = 1_000.0  # una pared alta y lejana al norte del polo (y > 0)
    m, _ = cs.hybrid_mask(fine, coarse, -90.0 + 1e-9, 0.0)
    assert m.max() > 1.5 and np.argmax(m) in (0, 359, 1)


def test_write_terrain_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(cs, "TERRAIN_DIR", tmp_path)
    fine = cs.Level(np.array([[1.0, -2.5], [1000.25, 7.0]]), -160.0, 160.0, 160.0)
    coarse = cs.Level(np.array([[3.0]]), -200.0, 200.0, 400.0)
    paths = cs.write_terrain(fine, coarse)
    header = json.loads(paths[0].read_text(encoding="utf-8"))
    q = np.frombuffer(paths[1].read_bytes(), dtype="<i2").reshape(2, 2) * header["height_scale_m"]
    assert np.allclose(q, [[1.0, -2.5], [1000.0, 7.0]], atol=0.5)
    assert header["fine"]["byte_length"] == 8 and header["coarse"]["nx"] == 1 and header["near_m"] == cs.NEAR_M
