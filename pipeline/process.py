"""Turn a stack of NISAR interferograms into ground motion over time.

Input: the per pair windows cached by fetch.py (unwrapped phase, coherence,
ionosphere screen, masks) for one track and frame.

Output (all on the stack's 80 m UTM grid):
  dates        acquisition dates
  cum          cumulative vertical motion at every date, metres (negative = sinking)
  velocity     best fit linear rate, metres per year
  sigma        map noise level of the velocity, metres per year (a single number)
  beta_rate    angular distortion rate, 1 per year (differential settlement
               between neighbouring ground, the quantity that damages buildings)
  valid        pixels we trust

Method, in the order it runs:
  1. phase minus the split spectrum ionosphere screen shipped with the product
  2. phase to line of sight displacement, projected to vertical
  3. per interferogram referencing and plane removal over stable ground
  4. small baseline style network inversion to a displacement time series
  5. atmospheric phase screen filter (high pass in time, low pass in space)
  6. linear rate, noise level, significant subsidence mask, distortion rate
"""
from __future__ import annotations

from datetime import date

import numpy as np
from scipy import ndimage as ndi


def _d(s: str) -> date:
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def mad_sigma(a) -> float:
    a = a[np.isfinite(a)]
    if a.size == 0:
        return float("nan")
    m = np.median(a)
    return float(1.4826 * np.median(np.abs(a - m)))


def smooth(a, sigma, valid=None):
    """Gaussian smoothing that ignores invalid pixels (normalised convolution)."""
    if valid is None:
        valid = np.isfinite(a)
    w = valid.astype(np.float32)
    num = ndi.gaussian_filter(np.where(valid, a, 0).astype(np.float32), sigma, mode="nearest")
    den = ndi.gaussian_filter(w, sigma, mode="nearest")
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    out[den < 0.05] = np.nan
    return out


def smooth_weighted(a, w, sigma):
    """Gaussian smoothing with per pixel weights (0 where invalid)."""
    num = ndi.gaussian_filter(np.where(w > 0, a * w, 0).astype(np.float32), sigma, mode="nearest")
    den = ndi.gaussian_filter(w.astype(np.float32), sigma, mode="nearest")
    with np.errstate(invalid="ignore", divide="ignore"):
        return num / den


def _fit_surface(u, mask, dem=None, step=4):
    """Least squares plane (plus a term proportional to elevation when a DEM is
    given) through u over mask. Returns the fitted surface everywhere.

    The plane absorbs orbit and long wavelength atmosphere errors. The elevation
    term absorbs the layered part of the troposphere, which otherwise paints
    false motion onto mountains.
    """
    ny, nx = u.shape
    yy, xx = np.mgrid[0:ny:step, 0:nx:step]
    m = mask[::step, ::step]
    if m.sum() < 50:
        return np.zeros_like(u)
    cols = [np.ones(int(m.sum())), xx[m] / nx - 0.5, yy[m] / ny - 0.5]
    h0, hs = 0.0, 1.0
    use_dem = dem is not None and np.ptp(dem[::step, ::step][m]) > 150
    if use_dem:
        hm = dem[::step, ::step][m]
        h0, hs = float(np.median(hm)), float(np.ptp(hm))
        cols.append((hm - h0) / hs)
    G = np.column_stack(cols).astype(np.float64)
    z = u[::step, ::step][m]
    keep = np.ones(len(z), bool)
    for _ in range(2):   # reject outliers so real motion does not pull the fit
        coef, *_ = np.linalg.lstsq(G[keep], z[keep], rcond=None)
        res = z - G @ coef
        keep = np.abs(res) < 2.5 * max(mad_sigma(res[keep]), 1e-6)
    Y, X = np.mgrid[0:ny, 0:nx]
    out = coef[0] + coef[1] * (X / nx - 0.5) + coef[2] * (Y / ny - 0.5)
    if use_dem:
        out = out + coef[3] * (dem - h0) / hs
    return out.astype(np.float32)


def fix_components(phi, cc, valid):
    """Bring secondary unwrapping components onto the main one.

    The unwrapper solves each connected component independently, so islands can
    sit a whole number of cycles away from the mainland. For each island we
    compare it to the main component and remove the nearest multiple of 2 pi.
    """
    labels, counts = np.unique(cc[valid], return_counts=True)
    if len(labels) <= 1:
        return phi
    main = labels[np.argmax(counts)]
    out = phi.copy()
    main_mask = valid & (cc == main)
    # low pass copy of the main component, extended outwards, to compare against
    ref = smooth(np.where(main_mask, phi, np.nan), 12, main_mask)
    for lab, n in zip(labels, counts):
        if lab == main:
            continue
        m = valid & (cc == lab)
        near = ref[m]
        if np.isfinite(near).sum() < 10 or n < 30:
            out[m] = np.nan  # too small or too isolated to tie in
            continue
        k = np.round(np.nanmedian(phi[m] - near) / (2 * np.pi))
        out[m] = phi[m] - k * 2 * np.pi
    return out


def invert_network(pairs, dates, U, gamma=0.1):
    """Solve for cumulative displacement at each date from pairwise data.

    pairs: [(ref_index, sec_index)], U: (n_pairs, n_pix) displacement per pair.
    Unknowns are the mean rate over each interval between consecutive dates. A
    weak smoothness constraint keeps intervals no pair crosses from floating.
    Returns (n_dates, n_pix) with the first date at zero.
    """
    t = np.array([(d - dates[0]).days / 365.25 for d in dates])
    dt = np.diff(t)
    n_int = len(dt)
    B = np.zeros((len(pairs), n_int))
    for k, (a, b) in enumerate(pairs):
        B[k, a:b] = dt[a:b]
    R = np.zeros((n_int - 1, n_int))
    for j in range(n_int - 1):
        R[j, j], R[j, j + 1] = 1, -1
    R *= gamma * np.median(dt)
    G = np.vstack([B, R])
    Ginv = np.linalg.pinv(G)[:, :len(pairs)].astype(np.float32)
    rates = Ginv @ U                       # (n_int, n_pix)
    cum = np.zeros((len(dates), U.shape[1]), np.float32)
    np.cumsum(rates * dt[:, None].astype(np.float32), axis=0, out=cum[1:])
    return cum, t


def _noise_and_stable(v, good, k=2.0, grow=6):
    """Split ground into moving and not moving, and measure the noise level of
    the part that is not moving. Uses the upper side of the rate distribution,
    which sinking does not contaminate."""
    stable = good.copy()
    vs = smooth(v, 2.0, good)
    med, sig = 0.0, np.nan
    for _ in range(3):
        vals = v[stable & np.isfinite(v)]
        if vals.size < 200:
            break
        med = float(np.median(vals))
        sig = float(np.percentile(vals, 84.13) - med)
        moving = good & ((vs < med - k * sig) | (vs > med + (k + 1) * sig))
        moving = ndi.binary_dilation(ndi.binary_opening(moving, iterations=1), iterations=grow)
        stable = good & ~moving
    return med, sig, stable


def process_stack(items, dem=None, landcover=None, use_iono=False, atmo_px=50, smooth_px=1.2,
                  min_coh=0.4, max_gap_days=60, log=print):
    """items: list of dicts from fetch.load_cached, each with keys
    unw, coh, cc, iono, water, bad, meta, plus ref_date and sec_date.
    dem: elevation on the same grid (optional but recommended).
    landcover: ESA WorldCover classes on the same grid (optional but
    recommended). Only built up and bare ground is analysed.
    use_iono: subtract the product's split spectrum ionosphere screen.
    atmo_px: scale (pixels) of the atmosphere surface interpolated from stable
    ground and removed from every interferogram. 0 turns it off.
    smooth_px: width (pixels) of the final coherence weighted blur.
    min_coh: only ground whose radar echo stays this stable is analysed. Built
    up and bare ground passes. Forest, crops and wetlands mostly do not, and
    that is the point: over a short record their changing moisture looks like
    ground motion at L band. 0.4 rather than 0.5 measures a few percent more
    of each place; on the land cover kept it adds no false sinking in tests.
    max_gap_days: a hole in the chain of interferograms up to this long is
    bridged by assuming the rate carries on; a longer one splits the record."""
    items = sorted(items, key=lambda d: (d["ref_date"], d["sec_date"]))

    # throw out interferograms that failed as a whole (a bad acquisition shows
    # up as near zero coherence in both pairs that use it)
    def quality(it):
        land = ~it["water"]
        c = it["coh"][land & np.isfinite(it["coh"])]
        return (float(c.mean()) if c.size else 0.0), float(it["bad"][land].mean()) if land.any() else 1.0
    q = [quality(it) for it in items]
    med_coh = float(np.median([c for c, _ in q]))
    med_bad = float(np.median([b for _, b in q]))   # part of the box may lie outside the frame
    keep = [c >= max(0.15, 0.5 * med_coh) and bad <= med_bad + 0.2 for c, bad in q]
    if not all(keep):
        log(f"  dropped {len(keep) - sum(keep)} failed interferograms of {len(keep)}")
        items = [it for it, k in zip(items, keep) if k]
    if len(items) < 3:
        raise ValueError("too few usable interferograms")

    dates = sorted({_d(i["ref_date"]) for i in items} | {_d(i["sec_date"]) for i in items})
    idx = {d: k for k, d in enumerate(dates)}
    pairs = [(idx[_d(i["ref_date"])], idx[_d(i["sec_date"])]) for i in items]

    # intervals between consecutive dates that no interferogram spans
    covered = np.zeros(len(dates) - 1, bool)
    for a, b in pairs:
        covered[a:b] = True
    cuts = [j for j in range(len(dates) - 1)
            if not covered[j] and (dates[j + 1] - dates[j]).days > max_gap_days]
    if cuts:   # keep the longest piece between long holes
        edges = [0] + [j + 1 for j in cuts] + [len(dates)]
        lo, hi = max(zip(edges[:-1], edges[1:]), key=lambda e: (dates[e[1] - 1] - dates[e[0]]).days)
        log(f"  long gap in the record: using {dates[lo]} to {dates[hi - 1]}")
        sel = [k for k, (a, b) in enumerate(pairs) if a >= lo and b <= hi - 1]
        items = [items[k] for k in sel]
        dates = dates[lo:hi]
        pairs = [(pairs[k][0] - lo, pairs[k][1] - lo) for k in sel]
        if len(items) < 3:
            raise ValueError("too few usable interferograms")

    meta0 = items[0]["meta"]
    lam = float(meta0["wavelength"])
    inc = np.deg2rad(float(meta0["incidence"]))
    ny, nx = items[0]["unw"].shape
    n = len(items)
    span = np.array([(dates[b] - dates[a]).days / 365.25 for a, b in pairs], np.float32)

    water = np.zeros((ny, nx), bool)
    U = np.full((n, ny, nx), np.nan, np.float32)
    coh_sum = np.zeros((ny, nx), np.float32)
    coh_n = np.zeros((ny, nx), np.float32)
    for k, it in enumerate(items):
        valid = np.isfinite(it["unw"]) & (it["cc"] > 0) & ~it["bad"] & ~it["water"]
        water |= it["water"]
        phi = it["unw"].astype(np.float32)
        if use_iono:
            valid &= np.isfinite(it["iono"])
            phi = phi - it["iono"]
        phi = fix_components(np.where(valid, phi, np.nan), it["cc"], valid)
        # positive phase = range got longer = ground moved away from the radar
        los = -lam / (4 * np.pi) * phi
        U[k] = los / np.cos(inc)           # read as vertical motion, up positive
        c = it["coh"]
        ok = np.isfinite(c)
        coh_sum[ok] += c[ok]
        coh_n[ok] += 1
    coh = np.where(coh_n > 0, coh_sum / np.maximum(coh_n, 1), 0)

    finite = np.isfinite(U)
    frac = finite.mean(axis=0)
    good = (frac >= 0.8) & (coh >= min_coh) & ~water
    if landcover is not None:
        from .landcover import BUILT, MANGROVE, SOLID_GROUND, WATER, WETLAND
        # ground next to water and marsh behaves like marsh (and is often
        # mapped wrongly), so keep a 320 m margin. Built up land is kept:
        # waterfront districts are exactly where sinking matters.
        wet = ndi.binary_dilation(np.isin(landcover, (WATER, WETLAND, MANGROVE)), iterations=4)
        good &= np.isin(landcover, SOLID_GROUND) & (~wet | (landcover == BUILT))

    def rate_map():
        num = np.nansum(U, axis=0)
        # pairs can overlap in time, so normalise by covered time, not by count
        den = np.sum(np.where(finite, span[:, None, None], 0), axis=0)
        with np.errstate(invalid="ignore", divide="ignore"):
            return num / den

    # pass 1: plane and elevation term over all good ground; pass 2: stable only
    stable = good
    for _ in range(2):
        for k in range(n):
            U[k] -= _fit_surface(np.nan_to_num(U[k]), finite[k] & stable, dem)
        v0 = rate_map()
        med, sig1, stable = _noise_and_stable(v0, good)

    # pass 3: the atmosphere is smooth in space. Estimate it from stable ground,
    # carry it across the moving areas, and take it out of each interferogram.
    if atmo_px:
        for k in range(n):
            m = finite[k] & stable
            w = m.astype(np.float32)
            num = ndi.gaussian_filter(np.where(m, U[k], 0).astype(np.float32), atmo_px, mode="nearest")
            den = ndi.gaussian_filter(w, atmo_px, mode="nearest")
            U[k] -= np.where(den > 1e-4, num / np.maximum(den, 1e-4), 0)
        v0 = rate_map()
        med, sig1, stable = _noise_and_stable(v0, good)

    # fill the few missing samples of otherwise good pixels with their own rate
    pix = np.where(good.ravel())[0]
    Ug = U.reshape(n, -1)[:, pix]
    miss = ~np.isfinite(Ug)
    if miss.any():
        fill = np.nan_to_num(v0.ravel()[pix])[None, :] * span[:, None]
        Ug = np.where(miss, fill, Ug)

    cum_g, t = invert_network(pairs, dates, Ug)
    nd = len(dates)

    def to_grid(vec):
        out = np.full(ny * nx, np.nan, np.float32)
        out[pix] = vec
        return out.reshape(ny, nx)

    def linfit(cg):
        tc = t - t.mean()
        v = (tc[:, None] * (cg - cg.mean(axis=0))).sum(axis=0) / (tc ** 2).sum()
        c = cg.mean(axis=0) - v * t.mean()
        return v.astype(np.float32), c.astype(np.float32)

    # atmospheric phase screen: what is fast in time but smooth in space
    v_g, c_g = linfit(cum_g)
    res = cum_g - (v_g[None, :] * t[:, None] + c_g[None, :])
    tw = 30.0 / 365.25
    W = np.exp(-0.5 * ((t[:, None] - t[None, :]) / tw) ** 2)
    W /= W.sum(axis=1, keepdims=True)
    res_hp = res - (W.astype(np.float32) @ res)
    cum = np.full((nd, ny, nx), np.nan, np.float32)
    for k in range(nd):
        aps = smooth(to_grid(res_hp[k]), 12, good)     # 12 px, about 1 km
        cum[k] = to_grid(cum_g[k]) - aps
    # speckle like noise adds up along a chain of interferograms. It is white
    # in space, so a light blur weighted by coherence (inverse variance) beats
    # it down without smearing features wider than about 200 m.
    g2 = np.clip(coh, 0.05, 0.98) ** 2
    wgt = np.where(good, g2 / (1 - g2), 0).astype(np.float32)
    for k in range(nd):
        f = smooth_weighted(np.nan_to_num(cum[k]), wgt, smooth_px)
        cum[k] = np.where(good, f, np.nan)
    cum -= cum[0][None]                    # first date is the zero level
    cum_g = cum.reshape(nd, -1)[:, pix]
    v_g, c_g = linfit(cum_g)
    res = cum_g - (v_g[None, :] * t[:, None] + c_g[None, :])
    rms = to_grid(np.sqrt((res ** 2).mean(axis=0)))
    velocity = to_grid(v_g)

    # drop pixels whose history is erratic, and isolated spikes
    rms_lim = max(3 * float(np.nanmedian(rms[good])), 0.015)
    good &= ~(rms > rms_lim)
    medv = ndi.median_filter(np.nan_to_num(velocity), size=3)
    spike = good & (np.abs(velocity - medv) > max(6 * sig1, 0.03))
    good &= ~spike
    velocity[~good] = np.nan
    cum[:, ~good] = np.nan

    med, sigma, stable = _noise_and_stable(velocity, good)
    velocity -= med                         # typical stable ground is the zero level
    cum -= (med * t)[:, None, None]

    return dict(
        dates=[d.isoformat() for d in dates], t=t, cum=cum, velocity=velocity,
        sigma=sigma, valid=good, coherence=coh,
        incidence=float(meta0["incidence"]), wavelength=lam,
        direction=str(meta0["direction"]), look=str(meta0["look"]), n_pairs=n,
    )


def sustained(cum, t, velocity, share=0.3):
    """True where sinking keeps going through the whole record.

    A single episode (frozen or snow covered ground in one winter, a flood, a
    construction site) can drag the fitted rate down even though nothing moves
    before or after it. Real compaction keeps going. The record is cut into
    three parts of equal length (two when it has fewer than 12 dates), and in
    every part the ground must have sunk at least `share` of what the fitted
    rate predicts for that part.
    """
    t = np.asarray(t, float)
    parts = 3 if len(t) >= 12 else 2
    edges = [int(np.argmin(np.abs(t - t[-1] * j / parts))) for j in range(parts + 1)]
    ok = np.isfinite(velocity) & (velocity < 0)
    for a, b in zip(edges[:-1], edges[1:]):
        if b <= a:
            continue
        moved = cum[b] - cum[a]
        expected = velocity * (t[b] - t[a])
        with np.errstate(invalid="ignore"):
            ok &= moved <= share * expected
    return ok


def _patch_sizes(mask):
    """Connected patches of a mask: (labels, number of pixels in each patch)."""
    lab, n = ndi.label(mask)
    sizes = ndi.sum(mask, lab, index=np.arange(1, n + 1)) if n else np.zeros(0)
    return lab, sizes


def _keep_patches(mask, min_px):
    """The mask without its patches smaller than min_px pixels."""
    lab, sizes = _patch_sizes(mask)
    return np.isin(lab, 1 + np.where(sizes >= min_px)[0])


def chance_patch_px(chance, area_ratio, least=8):
    """Smallest patch (in pixels) that chance is expected to produce less than once.

    chance: ground that is not sinking and passes the distortion floor anyway.
    One pixel in a hundred does, by construction, and they come in patches.
    area_ratio: the area searched for uneven sinking divided by the area of
    that quiet ground. The answer is the patch size that quiet ground reaches
    fewer than 1 / area_ratio times, and never less than `least` pixels
    (0.05 km2, the smallest area the map reports).
    """
    _, sizes = _patch_sizes(chance)
    allowed = int(np.ceil(1.0 / max(area_ratio, 1e-9))) - 1
    if allowed >= len(sizes):
        return least
    return max(least, int(np.sort(sizes)[::-1][allowed]) + 1)


def detect(velocity, valid, slope=None, span_years=1.0, steady=None, pixel_m=80.0, seasonal_m=0.01,
           tilt_px=3.0):
    """Find ground that is clearly sinking and measure how unevenly it sinks.

    Returns dict(sigma, threshold, significant, beta_rate, beta_floor,
    beta_min_px, median).
      significant  sinking faster than the detection threshold, on gentle
                   terrain, in patches of at least a quarter of a km2 (0.64 km2
                   when the record is shorter than about eight months)
      beta_rate    angular distortion rate (1/yr): how fast neighbouring ground
                   is tilting relative to each other. Uniform sinking does not
                   crack buildings; uneven sinking does. Measured on the rate
                   map smoothed over tilt_px pixels (3 pixels: about 240 m),
                   which halves the noise floor compared with one pixel, so
                   the gentle tilt that passes a limit over decades shows
                   instead of being lost under the noise. Zero unless it stands
                   clear of the noise: steeper than 99 percent of the ground
                   that is not sinking (beta_floor), in a patch larger than
                   that ground would show even once by chance (beta_min_px).
                   The map multiplies this rate by decades, so a few noisy
                   pixels must not get through.

    steady: optional mask from sustained(); sinking that is not sustained
    through the record is not counted.

    The threshold is the largest of: three times the map noise; 5 mm per year;
    and seasonal_m divided by the record length. The last term is there because
    wet and dry seasons move the radar phase without the ground going anywhere.
    Over a few months that reads as a trend; over a full year it mostly cancels.
    Short records therefore have to clear a higher bar. On farmland the effect
    is several centimetres, which is why only built up and bare ground is
    analysed; there a centimetre is allowed. Tested on cities that are not
    known to sink (London, Paris, New York, Toronto, Sydney, Singapore,
    Amsterdam, Madrid), it detects nothing, while Jakarta and Bangkok show.
    """
    med, sigma, stable = _noise_and_stable(velocity, valid)
    thr = max(3 * sigma, 0.005, seasonal_m / max(span_years, 0.1))
    sig = (velocity - med < -thr) & valid
    if slope is not None:
        sig &= slope < 8.0
    if steady is not None:
        sig &= steady
    min_px = 40 if span_years >= 0.7 else 100    # 0.25 km2, or 0.64 km2 for short records
    sig = _keep_patches(sig, min_px)

    gy, gx = np.gradient(smooth(velocity, tilt_px, valid), pixel_m)
    beta = np.hypot(gx, gy)
    quiet = valid & ~ndi.binary_dilation(sig, iterations=8) & np.isfinite(beta)
    near = ndi.binary_dilation(sig, iterations=5) & valid & np.isfinite(beta)
    beta_floor, beta_min_px = 0.0, 8
    if quiet.sum() > 500:      # enough quiet ground to tell what noise looks like
        beta_floor = float(np.nanpercentile(beta[quiet], 99))
        beta_min_px = chance_patch_px(quiet & (beta > beta_floor), near.sum() / quiet.sum())
    uneven = _keep_patches(near & (beta > beta_floor), beta_min_px)
    beta_rate = np.where(uneven, beta, 0).astype(np.float32)
    return dict(sigma=sigma, threshold=thr, significant=sig, beta_rate=beta_rate,
                beta_floor=beta_floor, beta_min_px=beta_min_px, median=med)
