#!/usr/bin/env python3
"""Total the size of NISAR GUNW granules intersecting the contiguous US.

Queries NASA CMR (no login or AWS needed) and sums the main .h5 file of each
granule. Nothing is downloaded.

Usage:
    python3 scripts/estimate_us_gunw_size.py
    python3 scripts/estimate_us_gunw_size.py --bbox=-125,32,-114,42   # e.g. California
    python3 scripts/estimate_us_gunw_size.py --start 2026-01-01T00:00:00Z
"""
import argparse
import json
import urllib.request
from collections import defaultdict

CMR_URL = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"

# One CMR collection per NISAR product maturity level.
COLLECTIONS = {
    "BETA": "C2850261892-ASF",
    "PROVISIONAL": "C2854335566-ASF",
    "VALIDATED": "C3622247503-ASF",
}

# Contiguous US: west,south,east,north
US_BBOX = "-125,24,-66,49.5"


def fetch_granules(collection_id, bbox, start, end):
    """Yield (name, size_bytes) for the main .h5 file of every matching granule."""
    params = f"collection_concept_id={collection_id}&bounding_box={bbox}&page_size=2000"
    if start or end:
        params += f"&temporal={start or ''},{end or ''}"
    search_after = None
    while True:
        req = urllib.request.Request(f"{CMR_URL}?{params}")
        if search_after:
            req.add_header("CMR-Search-After", search_after)
        with urllib.request.urlopen(req, timeout=60) as resp:
            search_after = resp.headers.get("CMR-Search-After")
            items = json.load(resp).get("items", [])
        if not items:
            return
        for item in items:
            files = item["umm"].get("DataGranule", {}).get("ArchiveAndDistributionInformation", [])
            for f in files:
                name = f["Name"]
                if name.endswith(".h5") and "_QA_STATS" not in name:
                    yield name, f["SizeInBytes"]
        if not search_after:
            return


def fmt(n):
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if n < 1024 or unit == "PB":
            return f"{n:.2f} {unit}"
        n /= 1024


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--bbox", default=US_BBOX, help="west,south,east,north (default: contiguous US)")
    p.add_argument("--start", help="ISO start time, e.g. 2026-01-01T00:00:00Z")
    p.add_argument("--end", help="ISO end time")
    args = p.parse_args()

    grand_count, grand_bytes = 0, 0
    print(f"bbox: {args.bbox}\n")
    for level, cid in COLLECTIONS.items():
        count, total = 0, 0
        for _name, size in fetch_granules(cid, args.bbox, args.start, args.end):
            count += 1
            total += size
        grand_count += count
        grand_bytes += total
        avg = fmt(total / count) if count else "-"
        print(f"{level:<12} {count:>6} granules  {fmt(total):>10}  (avg {avg})")
    print(f"{'TOTAL':<12} {grand_count:>6} granules  {fmt(grand_bytes):>10}")
    print("\nNote: the bbox query returns granules that overlap the box, so it includes")
    print("parts of Canada, Mexico and ocean. Treat the total as an upper bound.")


if __name__ == "__main__":
    main()
