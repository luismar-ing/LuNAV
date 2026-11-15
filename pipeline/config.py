"""Parámetros del pipeline: decisiones confirmadas (docs/DECISIONS.md) y rangos derivados.

Única fuente de estos valores para todo el pipeline. Si cambia una decisión, se cambia aquí.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

# D4: llegadas durante un año (2027-01-01 a 2027-12-31, ambos incluidos)
ARRIVAL_START = datetime(2027, 1, 1, tzinfo=timezone.utc)
ARRIVAL_END = datetime(2027, 12, 31, tzinfo=timezone.utc)

# D5: trayectoria ILLUSTRATIVE. A16: despega de Cabo Cañaveral, Launch Complex 39A (coordenadas publicadas en
# https://en.wikipedia.org/wiki/Kennedy_Space_Center_Launch_Complex_39A: 28°36′30″N 80°36′16″W), al mediodía solar
# medio de la plataforma (12:00 − lon/15 h UTC = 17:22:25 UTC), redondeado al minuto (17:22 UTC), con luz de día. Las
# llegadas son a las 00:00 UTC, así que el mediodía más cercano a los 3 días de D5 cae 4 días antes de la llegada:
# tránsito de 3 d 6 h 38 min (4718/1440 días, exacto en segundos).
TRAJECTORY_MODE = "ILLUSTRATIVE"
PAD_LAT_DEG, PAD_LON_DEG = 28.60833, -80.60444
LAUNCH_MINUTE_UTC = round((12 - PAD_LON_DEG / 15) * 60)  # 1042 = 17:22
TRANSIT_DAYS = (4 * 1440 - LAUNCH_MINUTE_UTC) / 1440

# D12: observador y antena
H_OBS_M = 3.0
ANTENNA_MARGIN_DEG = 0.5

# Spec 5.1, 5.2, 5.3, 5.6, 5.8
STEP_MIN = 30
SCENE_STEP_MIN = 60
WINDOW_DAYS = (3, 7, 14)
SUN_RADIUS_DEG = 0.265
EARTH_RADIUS_DEG = 0.95  # spec 5.4: radio angular aproximado de la Tierra vista desde la Luna
SUN_CRITERION = "upper_limb"  # spec 5.3, criterio por defecto; alternativa: "disk_fraction"
SUN_FRACTION_THRESHOLD = 0.5  # spec 5.3: «día» si la fracción visible del disco supera este umbral
HORIZON_AZ_STEP_DEG = 1.0
HORIZON_R_MAX_KM = 100.0
SCORE_WEIGHTS = {"w1": 0.4, "w2": 0.3, "w3": 0.3}

# D10: características del sitio (5.10)
SLOPE_RADIUS_M = 1000.0
NEARBY_RADIUS_KM = 50.0  # rasgos con nombre oficial a esta distancia o menos
NEARBY_MAX = 8


def timeseries_range() -> tuple[datetime, datetime]:
    """[inicio, fin) de las series del sitio (contrato §2)."""
    return ARRIVAL_START, ARRIVAL_END + timedelta(days=1 + max(WINDOW_DAYS))


def scene_range() -> tuple[datetime, datetime]:
    """[inicio, fin) de la escena (contrato §2): desde el día anterior al primer despegue hasta el fin de las series."""
    return ARRIVAL_START - timedelta(days=math.ceil(TRANSIT_DAYS) + 1), timeseries_range()[1]
