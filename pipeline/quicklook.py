"""Small PNG previews for checking pipeline output by eye (no matplotlib needed)."""
from __future__ import annotations

import numpy as np
from PIL import Image

# dark blue (sinking) to white (stable) to red (rising)
_STOPS = np.array([
    [-1.0, 8, 29, 88], [-0.6, 37, 52, 148], [-0.3, 65, 182, 196], [-0.08, 199, 233, 180],
    [0.0, 245, 245, 240], [0.3, 253, 174, 97], [1.0, 165, 0, 38],
], float)


def colorize(a, vmax):
    x = np.clip(a / vmax, -1, 1)
    out = np.zeros(a.shape + (3,), np.uint8)
    for c in range(3):
        out[..., c] = np.interp(x, _STOPS[:, 0], _STOPS[:, c + 1]).astype(np.uint8)
    out[~np.isfinite(a)] = (40, 40, 40)
    return out


def save(path, a, vmax):
    Image.fromarray(colorize(a, vmax)).save(path)


def save_gray(path, a, vmax):
    x = np.clip(np.nan_to_num(a) / vmax, 0, 1)
    Image.fromarray((x * 255).astype(np.uint8)).save(path)
