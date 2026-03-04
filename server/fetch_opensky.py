#!/usr/bin/env python3
"""
OpenSky Network REST API — Middle East Flight Data Fetcher
==========================================================
Fetches real-time ADS-B state vectors via:
  GET https://opensky-network.org/api/states/all

Features
--------
- Bounding-box filtering for the Middle East (configurable)
- Maps raw positional arrays to named fields (OpenSky docs §2.1)
- Cleans and type-casts every field
- Unit conversions: m/s → knots, metres → feet
- Basic military-aircraft heuristics
- Returns a tidy pandas DataFrame
- Auth via OPENSKY_USERNAME / OPENSKY_PASSWORD env vars (optional)
- Exports to CSV / JSON on request

Usage
-----
  python fetch_opensky.py                  # pretty-print DataFrame
  python fetch_opensky.py --csv out.csv    # save to CSV
  python fetch_opensky.py --json out.json  # save to JSON (records orient)
  python fetch_opensky.py --loop 30        # poll every 30 seconds

Importable
----------
  from fetch_opensky import fetch_middle_east_flights
  df = fetch_middle_east_flights()
"""

import os
import sys
import time
import math
import argparse
import logging
from datetime import datetime, timezone
from typing import Optional

import requests
import pandas as pd

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("opensky")

# ── Constants ─────────────────────────────────────────────────────────────────

OPENSKY_BASE = "https://opensky-network.org/api"
STATES_ENDPOINT = f"{OPENSKY_BASE}/states/all"

# Middle East bounding box (decimal degrees)
#   lamin / lamax = south / north latitude limits
#   lomin / lomax = west  / east  longitude limits
MIDDLE_EAST_BBOX = dict(lamin=22.0, lomin=29.0, lamax=42.0, lomax=60.0)

# Timeout / retry config
REQUEST_TIMEOUT = 20          # seconds
MAX_RETRIES = 3
RETRY_BACKOFF = 5             # seconds between retries

# ── State-vector field index → key mapping (OpenSky API docs §2.1) ──────────
#
# Each state is an ordered list of 17 values.  The mapping below documents
# every field so the raw index never appears in downstream code.

STATE_FIELDS: list[str] = [
    "icao24",           # 0  ICAO 24-bit address  (hex, e.g. "3c6444")
    "callsign",         # 1  Callsign, 8 chars, may be space-padded
    "origin_country",   # 2  Country of origin (derived from ICAO)
    "time_position",    # 3  Unix timestamp of last position update (int|null)
    "last_contact",     # 4  Unix timestamp of last received message (int)
    "longitude",        # 5  WGS-84 longitude, degrees  (float|null)
    "latitude",         # 6  WGS-84 latitude, degrees   (float|null)
    "baro_altitude",    # 7  Barometric altitude, metres (float|null)
    "on_ground",        # 8  True if aircraft is on the ground (bool)
    "velocity",         # 9  Ground speed, m/s  (float|null)
    "true_track",       # 10 True track (heading), degrees, 0=N clockwise (float|null)
    "vertical_rate",    # 11 Vertical rate, m/s; positive = climbing (float|null)
    "sensors",          # 12 Receiver IDs that contributed (list|null)
    "geo_altitude",     # 13 Geometric (GPS) altitude, metres (float|null)
    "squawk",           # 14 Transponder squawk code, 4-digit octal string
    "spi",              # 15 Special Purpose Indicator (bool)
    "position_source",  # 16 0=ADS-B, 1=ASTERIX, 2=MLAT, 3=FLARM (int)
]

# Human-readable labels for position_source
POSITION_SOURCE_LABEL: dict[int, str] = {
    0: "ADS-B",
    1: "ASTERIX",
    2: "MLAT",
    3: "FLARM",
}

# ── Conversion helpers ────────────────────────────────────────────────────────

M_S_TO_KNOTS = 1.94384
METRES_TO_FEET = 3.28084


def mps_to_knots(v: Optional[float]) -> Optional[float]:
    """Convert m/s to knots, return None for null values."""
    return round(v * M_S_TO_KNOTS, 1) if v is not None else None


def metres_to_feet(m: Optional[float]) -> Optional[float]:
    """Convert metres to feet, return None for null values."""
    return round(m * METRES_TO_FEET) if m is not None else None


def unix_to_utc(ts: Optional[float]) -> Optional[str]:
    """Convert a Unix timestamp to an ISO-8601 UTC string, or None."""
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── Military heuristics ───────────────────────────────────────────────────────

# Callsign prefixes associated with military operations in the Middle East
MILITARY_CALLSIGN_PREFIXES: tuple[str, ...] = (
    "RCH", "REACH", "JAKE", "PACK", "SPAR", "DOOM", "HAVOC",
    "TOPCAT", "DISCO", "GHOST", "WOLF", "COBRA", "VIPER",
    "RAVEN", "MAGMA", "BONE", "BUFF", "STEEL", "BUCK",
    "SWORD", "SULTAN", "TORCH", "ATLAS", "KNIGHT", "DUKE",
    "FORCE", "DARK",
)

# ICAO 24-bit hex ranges allocated to military operators
# Each entry: (inclusive_min_hex, inclusive_max_hex)
MILITARY_HEX_RANGES: tuple[tuple[int, int], ...] = (
    (0xAE0000, 0xAEFFFF),  # US Air Force
    (0xA00000, 0xA3FFFF),  # US DoD (general)
    (0x43C000, 0x43CFFF),  # UK Military
    (0x3A8000, 0x3AFFFF),  # French military
    (0x710000, 0x71FFFF),  # Israeli military (IAF allocation)
    (0x730000, 0x73FFFF),  # Saudi military (RSAF)
)


def is_military(icao24: str, callsign: str) -> bool:
    """Heuristic check: return True if the aircraft is likely military."""
    cs = callsign.upper().strip()
    if any(cs.startswith(prefix) for prefix in MILITARY_CALLSIGN_PREFIXES):
        return True
    try:
        hex_val = int(icao24, 16)
        if any(lo <= hex_val <= hi for lo, hi in MILITARY_HEX_RANGES):
            return True
    except ValueError:
        pass
    return False


# ── OAuth2 token manager ──────────────────────────────────────────────────────

OPENSKY_AUTH_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network"
    "/protocol/openid-connect/token"
)

_token_cache: dict = {}   # keys: access_token, expires_at


def _get_access_token() -> Optional[str]:
    """
    Fetch (or return cached) a Bearer token via client_credentials grant.
    Reads OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET from environment.
    Token TTL = 30 min; refreshed 60 s before expiry.
    Returns None if credentials are not configured.
    """
    client_id     = os.getenv("OPENSKY_CLIENT_ID", "").strip()
    client_secret = os.getenv("OPENSKY_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return None

    # Return cached token if still fresh
    if _token_cache.get("access_token") and time.time() < _token_cache.get("expires_at", 0) - 60:
        return _token_cache["access_token"]

    try:
        resp = requests.post(
            OPENSKY_AUTH_URL,
            data={
                "grant_type":    "client_credentials",
                "client_id":     client_id,
                "client_secret": client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        _token_cache["access_token"] = data["access_token"]
        _token_cache["expires_at"]   = time.time() + data.get("expires_in", 1800)
        log.info("[Auth] Token obtained — expires in %ds", data.get("expires_in", 1800))
        return _token_cache["access_token"]
    except Exception as exc:
        log.error("[Auth] Token request failed: %s", exc)
        _token_cache.clear()
        return None


def _get_auth_headers() -> dict:
    """Return headers dict with Authorization: Bearer <token>, or empty if unauthenticated."""
    token = _get_access_token()
    headers = {"User-Agent": "SentinelDashboard/0.2"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


# Keep _get_auth as a compatibility shim used by older call sites
def _get_auth() -> Optional[tuple[str, str]]:
    """Deprecated — use _get_auth_headers() instead. Returns None (Basic auth no longer used)."""
    return None


def fetch_states(
    bbox: dict = MIDDLE_EAST_BBOX,
    auth: Optional[tuple[str, str]] = None,   # kept for API compatibility, ignored
) -> dict:
    """
    Call GET /states/all and return the raw JSON response dict.

    Parameters
    ----------
    bbox : dict
        Keys: lamin, lomin, lamax, lomax  (decimal degrees)
    auth : ignored — authentication now uses OAuth2 Bearer token automatically.

    Returns
    -------
    dict with keys:
        "time"   – int, Unix timestamp of the data snapshot
        "states" – list of state vectors (each a 17-element list)
    """
    if auth is None:
        auth = _get_auth()

    params = {k: v for k, v in bbox.items()}

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            log.info(
                "Fetching states/all  bbox=(%.1f,%.1f,%.1f,%.1f)  attempt=%d",
                bbox["lamin"], bbox["lomin"], bbox["lamax"], bbox["lomax"],
                attempt,
            )
            resp = requests.get(
                STATES_ENDPOINT,
                params=params,
                headers=_get_auth_headers(),
                timeout=REQUEST_TIMEOUT,
            )

            if resp.status_code == 200:
                return resp.json()
            elif resp.status_code == 404:
                log.warning("No data in bounding box (404)")
                return {"time": int(time.time()), "states": []}
            elif resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", RETRY_BACKOFF * attempt))
                log.warning("Rate limited (429) — waiting %ds", retry_after)
                time.sleep(retry_after)
            elif resp.status_code == 401:
                log.error("Authentication failed (401) — check OPENSKY_USERNAME/PASSWORD")
                return {"time": int(time.time()), "states": []}
            else:
                log.error("HTTP %d: %s", resp.status_code, resp.text[:200])

        except requests.exceptions.Timeout:
            log.warning("Request timed out (attempt %d/%d)", attempt, MAX_RETRIES)
        except requests.exceptions.ConnectionError as exc:
            log.warning("Connection error: %s", exc)

        if attempt < MAX_RETRIES:
            log.info("Retrying in %ds …", RETRY_BACKOFF)
            time.sleep(RETRY_BACKOFF)

    log.error("All %d attempts failed — returning empty result", MAX_RETRIES)
    return {"time": int(time.time()), "states": []}


def parse_states(raw_states: list[list]) -> list[dict]:
    """
    Convert the raw list-of-lists from /states/all into a list of dicts
    with human-readable keys, cleaned values, and derived fields.

    Unit conversions applied:
        velocity      m/s  → knots
        baro_altitude m    → feet
        geo_altitude  m    → feet
        vertical_rate m/s  → ft/min
    """
    records = []
    for sv in raw_states:
        if len(sv) < len(STATE_FIELDS):
            continue  # malformed vector — skip

        # Map raw indices to keys
        raw = dict(zip(STATE_FIELDS, sv))

        icao24   = (raw["icao24"] or "").strip().lower()
        callsign = (raw["callsign"] or "").strip()
        lat      = raw["latitude"]
        lon      = raw["longitude"]

        # Skip if no position fix
        if lat is None or lon is None:
            continue

        vel_ms    = raw["velocity"]
        baro_m    = raw["baro_altitude"]
        geo_m     = raw["geo_altitude"]
        vrate_ms  = raw["vertical_rate"]

        pos_src_int = raw["position_source"] or 0

        record = {
            # ── Identity ──────────────────────────────────────────
            "icao24":          icao24,
            "callsign":        callsign,
            "origin_country":  raw["origin_country"] or "",
            "squawk":          raw["squawk"] or "",

            # ── Position ──────────────────────────────────────────
            "latitude":        round(float(lat), 6),
            "longitude":       round(float(lon), 6),

            # ── Altitude (dual units) ─────────────────────────────
            "baro_altitude_m": baro_m,
            "baro_altitude_ft": metres_to_feet(baro_m),
            "geo_altitude_m":  geo_m,
            "geo_altitude_ft": metres_to_feet(geo_m),

            # ── Velocity / heading ────────────────────────────────
            "velocity_ms":     vel_ms,
            "velocity_kts":    mps_to_knots(vel_ms),
            "true_track_deg":  raw["true_track"],        # 0 = North, clockwise
            "vertical_rate_ms":  vrate_ms,
            "vertical_rate_fpm": round(vrate_ms * 196.85) if vrate_ms is not None else None,

            # ── State flags ───────────────────────────────────────
            "on_ground":       bool(raw["on_ground"]),
            "spi":             bool(raw["spi"]),

            # ── Data-source metadata ──────────────────────────────
            "position_source":       pos_src_int,
            "position_source_label": POSITION_SOURCE_LABEL.get(pos_src_int, "UNKNOWN"),
            "time_position":         raw["time_position"],
            "time_position_utc":     unix_to_utc(raw["time_position"]),
            "last_contact":          raw["last_contact"],
            "last_contact_utc":      unix_to_utc(raw["last_contact"]),

            # ── Derived ───────────────────────────────────────────
            "military": is_military(icao24, callsign),
        }
        records.append(record)

    return records


def to_dataframe(records: list[dict]) -> pd.DataFrame:
    """
    Convert a list of parsed flight records to a typed pandas DataFrame.
    """
    if not records:
        return pd.DataFrame()

    df = pd.DataFrame(records)

    # Enforce dtypes
    float_cols = ["latitude", "longitude",
                  "baro_altitude_m", "baro_altitude_ft",
                  "geo_altitude_m", "geo_altitude_ft",
                  "velocity_ms", "velocity_kts",
                  "true_track_deg", "vertical_rate_ms"]
    int_cols   = ["vertical_rate_fpm", "time_position", "last_contact",
                  "position_source"]
    bool_cols  = ["on_ground", "spi", "military"]
    str_cols   = ["icao24", "callsign", "origin_country", "squawk",
                  "position_source_label", "time_position_utc", "last_contact_utc"]

    for col in float_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    for col in int_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
    for col in bool_cols:
        if col in df.columns:
            df[col] = df[col].astype(bool)
    for col in str_cols:
        if col in df.columns:
            df[col] = df[col].fillna("").astype(str)

    # Logical column order
    ordered = [
        "icao24", "callsign", "origin_country", "military",
        "latitude", "longitude",
        "baro_altitude_ft", "geo_altitude_ft", "on_ground",
        "velocity_kts", "true_track_deg", "vertical_rate_fpm",
        "squawk", "spi", "position_source_label",
        "time_position_utc", "last_contact_utc",
        "baro_altitude_m", "geo_altitude_m", "velocity_ms",
        "vertical_rate_ms", "time_position", "last_contact",
        "position_source",
    ]
    df = df.reindex(columns=[c for c in ordered if c in df.columns])
    return df.reset_index(drop=True)


# ── /flights/aircraft — Route enrichment ─────────────────────────────────────

# In-process route cache: icao24 → { origin, destination, route, cached_at }
_route_cache: dict = {}
ROUTE_CACHE_TTL = 2 * 3600   # 2 hours in seconds


def _get_cached_route(icao24: str) -> Optional[dict]:
    entry = _route_cache.get(icao24)
    if entry is None:
        return None
    if time.time() - entry["cached_at"] > ROUTE_CACHE_TTL:
        del _route_cache[icao24]
        return None
    return entry


def fetch_flight_route(
    icao24: str,
    auth: Optional[tuple[str, str]] = None,
    lookback_hours: int = 24,
) -> Optional[dict]:
    """
    Query GET /flights/aircraft for a single icao24 and return its most
    recent departure/arrival airports.

    Parameters
    ----------
    icao24 : str
        ICAO 24-bit hex address (lowercase).
    auth : (username, password) or None
        Authenticated requests required — endpoint is not available anonymously.
    lookback_hours : int
        How many hours back to search for flight history (default 24).

    Returns
    -------
    dict with keys:
        origin       – ICAO 4-letter departure airport code, or None
        destination  – ICAO 4-letter arrival airport code, or None
        route        – "ORIG → DEST" string, or None
        cached_at    – Unix timestamp when this entry was cached
    None if not found or on error.
    """
    cached = _get_cached_route(icao24)
    if cached is not None:
        return cached

    if not os.getenv("OPENSKY_CLIENT_ID"):
        log.warning("[Routes] OPENSKY_CLIENT_ID required for /flights/aircraft — skipping")
        return None

    now   = int(time.time())
    begin = now - lookback_hours * 3600

    try:
        resp = requests.get(
            f"{OPENSKY_BASE}/flights/aircraft",
            params={"icao24": icao24, "begin": begin, "end": now},
            headers=_get_auth_headers(),
            timeout=REQUEST_TIMEOUT,
        )

        if resp.status_code == 404 or resp.text.strip() in ("", "[]"):
            entry = {"origin": None, "destination": None, "route": None, "cached_at": time.time()}
            _route_cache[icao24] = entry
            return entry

        if resp.status_code == 401:
            log.error("[Routes] 401 Unauthorized — check credentials")
            return None

        if resp.status_code == 429:
            log.warning("[Routes] 429 Rate limited")
            return None

        resp.raise_for_status()
        flights = resp.json()

        if not flights:
            entry = {"origin": None, "destination": None, "route": None, "cached_at": time.time()}
            _route_cache[icao24] = entry
            return entry

        # Pick the flight with the latest firstSeen (= most recent / current leg)
        latest = max(flights, key=lambda f: f.get("firstSeen", 0))
        origin      = latest.get("estDepartureAirport")   # ICAO code, e.g. "OMDB"
        destination = latest.get("estArrivalAirport")
        route       = f"{origin} → {destination}" if origin and destination else None

        entry = {"origin": origin, "destination": destination, "route": route, "cached_at": time.time()}
        _route_cache[icao24] = entry
        return entry

    except requests.exceptions.RequestException as exc:
        log.debug("[Routes] %s: %s", icao24, exc)
        return None


def enrich_with_routes(
    df: pd.DataFrame,
    delay: float = 0.5,
    batch_size: int = 5,
    auth: Optional[tuple[str, str]] = None,
) -> pd.DataFrame:
    """
    Add 'origin', 'destination', and 'route' columns to a flight DataFrame
    by calling fetch_flight_route() for each row.

    Uses a per-process cache — repeated calls for the same icao24 within
    ROUTE_CACHE_TTL (2 h) are served from memory without any HTTP request.

    Parameters
    ----------
    df : pd.DataFrame
        Must contain an 'icao24' column.
    delay : float
        Sleep time (seconds) between individual requests (default 0.5 s).
    batch_size : int
        Progress log every N rows.
    auth : (username, password) or None

    Returns
    -------
    df with three new columns: origin, destination, route
    """
    if "icao24" not in df.columns:
        raise ValueError("DataFrame must contain an 'icao24' column")

    if not os.getenv("OPENSKY_CLIENT_ID"):
        log.warning("[Routes] OPENSKY_CLIENT_ID not set — skipping route enrichment")
        df["origin"]      = None
        df["destination"] = None
        df["route"]       = None
        return df

    origins, destinations, routes = [], [], []
    total = len(df)

    for i, icao24 in enumerate(df["icao24"]):
        entry = fetch_flight_route(icao24)
        if entry:
            origins.append(entry["origin"])
            destinations.append(entry["destination"])
            routes.append(entry["route"])
        else:
            origins.append(None)
            destinations.append(None)
            routes.append(None)

        if (i + 1) % batch_size == 0 or (i + 1) == total:
            filled = sum(1 for r in routes if r)
            log.info("[Routes] %d/%d  (%d with route)", i + 1, total, filled)

        # Respect rate limits between requests for uncached icao24
        if entry is None or "cached_at" not in entry:
            time.sleep(delay)

    df = df.copy()
    df["origin"]      = origins
    df["destination"] = destinations
    df["route"]       = routes
    return df


# ── Public API ────────────────────────────────────────────────────────────────

def fetch_middle_east_flights(
    bbox: dict = MIDDLE_EAST_BBOX,
    filter_airborne: bool = True,
    filter_has_position: bool = True,
    with_routes: bool = False,
) -> pd.DataFrame:
    """
    Main entry point — fetch, parse, and return a clean DataFrame for
    Middle East airspace.

    Parameters
    ----------
    bbox : dict
        Bounding box override.  Defaults to MIDDLE_EAST_BBOX.
    filter_airborne : bool
        When True (default), drop records where on_ground is True.
    filter_has_position : bool
        When True (default), drop records with null latitude/longitude.
    with_routes : bool
        When True, call /flights/aircraft for each aircraft to add
        'origin', 'destination', 'route' columns.
        Requires OPENSKY_USERNAME / OPENSKY_PASSWORD to be set.
        Adds ~0.5 s × N requests of latency (cached per 2 h).

    Returns
    -------
    pandas.DataFrame
    """
    raw   = fetch_states(bbox=bbox)
    recs  = parse_states(raw.get("states") or [])
    df    = to_dataframe(recs)

    if df.empty:
        log.warning("No flight records returned for the bounding box")
        return df

    snapshot_ts  = raw.get("time", 0)
    snapshot_utc = unix_to_utc(snapshot_ts)

    if filter_airborne and "on_ground" in df.columns:
        before = len(df)
        df = df[~df["on_ground"]].reset_index(drop=True)
        log.info("Filtered airborne: %d → %d records", before, len(df))

    if "callsign" in df.columns:
        df = df.sort_values("callsign").reset_index(drop=True)

    log.info(
        "Snapshot: %s  |  Total: %d  |  Military: %d  |  Civilian: %d",
        snapshot_utc,
        len(df),
        df["military"].sum() if "military" in df.columns else "?",
        (~df["military"]).sum() if "military" in df.columns else "?",
    )

    if with_routes:
        log.info("Enriching routes via /flights/aircraft …")
        df = enrich_with_routes(df)
        with_route_count = df["route"].notna().sum() if "route" in df.columns else 0
        log.info("Routes resolved: %d / %d", with_route_count, len(df))

    return df


# ── Statistics helper ─────────────────────────────────────────────────────────

def print_summary(df: pd.DataFrame) -> None:
    """Print a formatted summary table for the given DataFrame."""
    if df.empty:
        print("No data.")
        return

    sep = "─" * 60
    print(f"\n{sep}")
    print(f"  OPENSKY  //  MIDDLE EAST AIRSPACE SNAPSHOT")
    print(f"  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(sep)
    print(f"  Total aircraft  : {len(df)}")
    if "military" in df.columns:
        mil = df["military"].sum()
        civ = len(df) - mil
        print(f"  Military        : {mil}")
        print(f"  Civilian        : {civ}")
    if "position_source_label" in df.columns:
        src_counts = df["position_source_label"].value_counts().to_dict()
        for src, cnt in src_counts.items():
            print(f"  {src:<15} : {cnt}")
    if "origin_country" in df.columns:
        print(f"\n  Top-5 origin countries:")
        for country, cnt in df["origin_country"].value_counts().head(5).items():
            print(f"    {country:<25} {cnt}")
    if "route" in df.columns:
        with_route = df["route"].notna().sum()
        print(f"\n  Routes resolved   : {with_route} / {len(df)}")
        if with_route:
            print(f"\n  Top-10 routes:")
            for route, cnt in df["route"].dropna().value_counts().head(10).items():
                print(f"    {route:<25} ×{cnt}")
    print(sep)

    # Pretty-print key columns
    display_cols = [c for c in [
        "callsign", "icao24", "origin_country", "military",
        "latitude", "longitude", "baro_altitude_ft",
        "velocity_kts", "true_track_deg",
    ] if c in df.columns]

    with pd.option_context(
        "display.max_rows", 40,
        "display.max_columns", None,
        "display.width", 120,
        "display.float_format", "{:.2f}".format,
    ):
        print(df[display_cols].to_string(index=True))
    print()


# ── CLI ───────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Fetch Middle East flight data from OpenSky Network REST API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--csv",  metavar="FILE", help="Save DataFrame to CSV")
    p.add_argument("--json", metavar="FILE", help="Save DataFrame to JSON (records orient)")
    p.add_argument("--loop", metavar="SECS", type=int, default=0,
                   help="Poll repeatedly every SECS seconds (0 = run once)")
    p.add_argument("--all",  action="store_true", dest="include_ground",
                   help="Include ground traffic (default: airborne only)")
    p.add_argument("--routes", action="store_true",
                   help="Enrich each aircraft with departure/arrival via /flights/aircraft")
    p.add_argument("--military-only", action="store_true",
                   help="Show only military aircraft")
    p.add_argument("--bbox", metavar="S,W,N,E", default=None,
                   help="Override bounding box  e.g. 22,29,42,60")
    p.add_argument("--debug", action="store_true", help="Enable debug logging")
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    # Override bounding box from CLI
    bbox = MIDDLE_EAST_BBOX.copy()
    if args.bbox:
        parts = [float(x) for x in args.bbox.split(",")]
        if len(parts) == 4:
            bbox = dict(lamin=parts[0], lomin=parts[1], lamax=parts[2], lomax=parts[3])
        else:
            log.error("--bbox must be S,W,N,E  e.g. 22,29,42,60")
            sys.exit(1)

    def run_once() -> pd.DataFrame:
        df = fetch_middle_east_flights(
            bbox=bbox,
            filter_airborne=not args.include_ground,
            with_routes=args.routes,
        )
        if args.military_only and not df.empty and "military" in df.columns:
            df = df[df["military"]].reset_index(drop=True)
        return df

    interval = args.loop if args.loop > 0 else None

    try:
        while True:
            df = run_once()
            print_summary(df)

            if args.csv and not df.empty:
                df.to_csv(args.csv, index=False)
                log.info("Saved CSV → %s  (%d rows)", args.csv, len(df))

            if args.json and not df.empty:
                df.to_json(args.json, orient="records", indent=2)
                log.info("Saved JSON → %s  (%d records)", args.json, len(df))

            if interval is None:
                break

            log.info("Next poll in %ds …  (Ctrl-C to stop)", interval)
            time.sleep(interval)

    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
