#!/usr/bin/env python3
"""
IPTV Aggregation Script
=======================
Fetches M3U/M3U8 playlists from:
  - Free-TV/IPTV  — /lists  and /playlists directories (via GitHub API)
  - iptv-org/iptv — index playlist

Optionally validates stream URLs, deduplicates, and outputs:
  - data/channels.json
  - data/channels.m3u
"""

import os
import re
import json
import time
import logging
import hashlib
import argparse
import asyncio
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlparse

import requests
import aiohttp

# ── Config ────────────────────────────────────────────────────
OUTPUT_DIR = Path(__file__).parent.parent / "data"
LOG_LEVEL  = logging.INFO

# GitHub API endpoints — both directories in Free-TV/IPTV
FREE_TV_DIRS = [
    "https://api.github.com/repos/Free-TV/IPTV/contents/lists",
    "https://api.github.com/repos/Free-TV/IPTV/contents/playlists",
]
IPTV_ORG_INDEX = "https://iptv-org.github.io/iptv/index.m3u"

# Validation settings
VALIDATE_STREAMS = os.getenv("VALIDATE_STREAMS", "false").lower() == "true"
VALIDATE_WORKERS = int(os.getenv("VALIDATE_WORKERS", "30"))
VALIDATE_TIMEOUT = float(os.getenv("VALIDATE_TIMEOUT", "8"))
MAX_CHANNELS     = int(os.getenv("MAX_CHANNELS", "0"))   # 0 = no limit

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
HEADERS = {
    "User-Agent": "iptv-collection-aggregator/1.0",
    **({"Authorization": f"token {GITHUB_TOKEN}"} if GITHUB_TOKEN else {}),
}

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


# ── M3U parser ────────────────────────────────────────────────

def parse_m3u(text: str, source: str = "") -> list[dict]:
    """Parse an M3U playlist string into a list of channel dicts."""
    channels = []
    lines    = text.splitlines()
    i        = 0

    while i < len(lines):
        line = lines[i].strip()

        if line.startswith("#EXTINF"):
            meta    = parse_extinf(line)
            url_idx = i + 1
            while url_idx < len(lines) and (not lines[url_idx].strip() or lines[url_idx].strip().startswith("#")):
                url_idx += 1

            if url_idx < len(lines):
                url = lines[url_idx].strip()
                if url and not url.startswith("#") and is_valid_url(url):
                    meta["url"]    = url
                    meta["source"] = source
                    channels.append(meta)
                i = url_idx + 1
            else:
                i += 1
        else:
            i += 1

    return channels


def parse_extinf(line: str) -> dict:
    """Extract attributes from an #EXTINF line."""
    channel: dict = {
        "name":         "",
        "logo":         "",
        "category":     "General",
        "country":      "",
        "country_name": "",
        "language":     "",
        "nsfw":         False,
        "tvg_id":       "",
    }

    # Channel name is after the last comma
    name_match = re.search(r",(.+)$", line)
    if name_match:
        channel["name"] = name_match.group(1).strip()

    def attr(key: str) -> str:
        # [^"]+ (one-or-more) skips empty attributes like tvg-country=""
        m = re.search(rf'{key}="([^"]+)"', line, re.IGNORECASE)
        return m.group(1).strip() if m else ""

    channel["logo"]         = attr("tvg-logo")
    channel["tvg_id"]       = attr("tvg-id")
    channel["country"]      = attr("tvg-country") or attr("country") or "Unknown"
    channel["country_name"] = attr("tvg-country") or attr("country") or "Unknown"
    channel["language"]     = attr("tvg-language") or attr("language") or "Unknown"

    group = attr("group-title")
    if group:
        channel["category"] = group

    if re.search(r'\b(adult|xxx|18\+|nsfw|erotic)\b', group, re.IGNORECASE):
        channel["nsfw"] = True

    return channel


def is_valid_url(url: str) -> bool:
    try:
        p = urlparse(url)
        return p.scheme in ("http", "https", "rtmp", "rtmps", "rtsp") and bool(p.netloc)
    except Exception:
        return False


def channel_id(ch: dict) -> str:
    """Stable deduplication key."""
    key = (ch.get("name", "") + ch.get("url", "")).lower().strip()
    return hashlib.md5(key.encode()).hexdigest()


# ── Fetchers ──────────────────────────────────────────────────

def fetch(url: str, timeout: int = 30) -> str | None:
    """GET a URL and return its text body, or None on any error."""
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True)
        r.raise_for_status()
        r.encoding = r.apparent_encoding or "utf-8"
        return r.text
    except requests.exceptions.Timeout:
        log.warning(f"Timeout fetching {url}")
    except requests.exceptions.HTTPError as e:
        log.warning(f"HTTP {e.response.status_code} fetching {url}")
    except requests.exceptions.RequestException as e:
        log.warning(f"Request error fetching {url}: {e}")
    return None


def _list_m3u_files_from_api(api_url: str) -> list[dict]:
    """
    Call a GitHub Contents API endpoint and return file entries
    whose names end with .m3u or .m3u8.
    Returns a list of dicts with at least {name, download_url}.
    """
    log.info(f"  Listing files via GitHub API: {api_url}")
    text = fetch(api_url)
    if not text:
        log.warning(f"  Could not reach API endpoint: {api_url}")
        return []

    try:
        entries = json.loads(text)
    except json.JSONDecodeError as e:
        log.warning(f"  JSON decode error for {api_url}: {e}")
        return []

    if not isinstance(entries, list):
        # GitHub returns a dict (with 'message') when rate-limited or not found
        msg = entries.get("message", "") if isinstance(entries, dict) else ""
        log.warning(f"  Unexpected API response for {api_url}: {msg or entries}")
        return []

    files = [
        e for e in entries
        if isinstance(e, dict)
        and e.get("type") == "file"
        and e.get("name", "").lower().endswith((".m3u", ".m3u8"))
        and e.get("download_url")
    ]
    log.info(f"  Found {len(files)} M3U/M3U8 file(s)")
    return files


def fetch_free_tv() -> list[dict]:
    """
    Fetch all M3U/M3U8 playlists from Free-TV/IPTV.

    Queries both /lists and /playlists via the GitHub REST API,
    uses each file's download_url to fetch raw content, parses it,
    and deduplicates by stream URL before returning.
    """
    log.info("=== Fetching Free-TV/IPTV ===")
    channels: list[dict] = []
    seen_urls: set[str]  = set()   # URL-level dedup within this source

    for api_url in FREE_TV_DIRS:
        files = _list_m3u_files_from_api(api_url)

        for file_entry in files:
            fname        = file_entry["name"]
            download_url = file_entry["download_url"]
            source_label = f"Free-TV/{fname}"

            log.info(f"  Downloading {fname} …")
            try:
                text = fetch(download_url, timeout=45)
            except Exception as e:
                log.warning(f"  Unexpected error downloading {fname}: {e}")
                continue

            if not text:
                log.warning(f"  Empty or failed response for {fname}, skipping")
                continue

            try:
                parsed = parse_m3u(text, source=source_label)
            except Exception as e:
                log.warning(f"  Parse error for {fname}: {e}")
                continue

            # Deduplicate by URL within this source
            new_channels = []
            for ch in parsed:
                url = ch.get("url", "").strip()
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    new_channels.append(ch)

            log.info(f"    → {len(new_channels)} unique channels (skipped {len(parsed)-len(new_channels)} dupes)")
            channels.extend(new_channels)

            time.sleep(0.2)   # be polite to GitHub's CDN

    log.info(f"Free-TV total: {len(channels)} channels from both directories")
    return channels


def fetch_iptv_org_index() -> list[dict]:
    """Fetch iptv-org main index playlist."""
    log.info("Fetching iptv-org index playlist…")
    text = fetch(IPTV_ORG_INDEX, timeout=60)
    if not text:
        log.warning("  iptv-org index unavailable")
        return []

    channels = parse_m3u(text, source="iptv-org/index")
    log.info(f"iptv-org index total: {len(channels)} channels")
    return channels


# ── Stream validation ─────────────────────────────────────────

async def check_stream(session: aiohttp.ClientSession, ch: dict) -> dict:
    """HEAD request to verify a stream URL is reachable."""
    url = ch.get("url", "")
    if not url or not url.startswith(("http://", "https://")):
        ch["status"] = "skip"
        return ch
    try:
        async with session.head(
            url,
            timeout=aiohttp.ClientTimeout(total=VALIDATE_TIMEOUT),
            allow_redirects=True,
        ) as resp:
            ch["status"] = "online" if resp.status < 400 else "offline"
    except Exception:
        ch["status"] = "offline"
    return ch


async def validate_all(channels: list[dict]) -> list[dict]:
    log.info(f"Validating {len(channels)} stream URLs (workers={VALIDATE_WORKERS}, timeout={VALIDATE_TIMEOUT}s)…")
    connector = aiohttp.TCPConnector(limit=VALIDATE_WORKERS, ssl=False)
    async with aiohttp.ClientSession(connector=connector, headers=HEADERS) as session:
        tasks = [check_stream(session, ch) for ch in channels]
        results = []
        for i in range(0, len(tasks), VALIDATE_WORKERS * 4):
            batch = await asyncio.gather(*tasks[i : i + VALIDATE_WORKERS * 4])
            results.extend(batch)
            online = sum(1 for c in results if c.get("status") == "online")
            log.info(f"  Progress: {len(results)}/{len(channels)} checked, {online} online")

    online  = [c for c in results if c.get("status") != "offline"]
    offline = len(results) - len(online)
    log.info(f"Validation done: {len(online)} reachable, {offline} removed")
    return online


# ── Enrichment ────────────────────────────────────────────────

# ISO 3166-1 alpha-2 → country name
COUNTRY_NAMES = {
    "AD": "Andorra", "AE": "UAE", "AF": "Afghanistan", "AR": "Argentina",
    "AT": "Austria", "AU": "Australia", "AZ": "Azerbaijan", "BA": "Bosnia",
    "BE": "Belgium", "BG": "Bulgaria", "BR": "Brazil", "BY": "Belarus",
    "CA": "Canada", "CH": "Switzerland", "CL": "Chile", "CN": "China",
    "CO": "Colombia", "CZ": "Czech Republic", "DE": "Germany", "DK": "Denmark",
    "DZ": "Algeria", "EG": "Egypt", "ES": "Spain", "FI": "Finland",
    "FR": "France", "GB": "United Kingdom", "GE": "Georgia", "GR": "Greece",
    "HR": "Croatia", "HU": "Hungary", "ID": "Indonesia", "IL": "Israel",
    "IN": "India", "IQ": "Iraq", "IR": "Iran", "IT": "Italy",
    "JO": "Jordan", "JP": "Japan", "KR": "South Korea", "KW": "Kuwait",
    "KZ": "Kazakhstan", "LB": "Lebanon", "LT": "Lithuania", "LV": "Latvia",
    "LY": "Libya", "MA": "Morocco", "MD": "Moldova", "ME": "Montenegro",
    "MK": "North Macedonia", "MX": "Mexico", "MY": "Malaysia", "NL": "Netherlands",
    "NO": "Norway", "NZ": "New Zealand", "PH": "Philippines", "PK": "Pakistan",
    "PL": "Poland", "PS": "Palestine", "PT": "Portugal", "QA": "Qatar",
    "RO": "Romania", "RS": "Serbia", "RU": "Russia", "SA": "Saudi Arabia",
    "SD": "Sudan", "SE": "Sweden", "SG": "Singapore", "SI": "Slovenia",
    "SK": "Slovakia", "SY": "Syria", "TH": "Thailand", "TN": "Tunisia",
    "TR": "Turkey", "TW": "Taiwan", "UA": "Ukraine", "US": "United States",
    "UZ": "Uzbekistan", "VN": "Vietnam", "YE": "Yemen", "ZA": "South Africa",
}

def enrich_channel(ch: dict, idx: int) -> dict:
    """Add derived fields to a channel dict."""
    code = ch.get("country", "").upper()
    if code and not ch.get("country_name"):
        ch["country_name"] = COUNTRY_NAMES.get(code, code)

    # Normalize category
    cat = ch.get("category", "General").strip()
    if not cat or cat in ("-", "undefined", "null"):
        cat = "General"
    ch["category"] = cat.title()

    # Stable ID
    ch["id"] = channel_id(ch)

    # Drop empty logo URLs
    logo = ch.get("logo", "").strip()
    if logo and not logo.startswith("http"):
        ch["logo"] = ""
    else:
        ch["logo"] = logo

    return ch


# ── Writers ───────────────────────────────────────────────────

def write_json(channels: list[dict]) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "total":      len(channels),
        "channels":   channels,
    }
    path = OUTPUT_DIR / "channels.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    log.info(f"Wrote {path} ({path.stat().st_size / 1024:.1f} KB)")
    return path


def write_m3u(channels: list[dict]) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    lines = ["#EXTM3U x-tvg-url=\"\""]
    for ch in channels:
        lines.append(
            f'#EXTINF:-1 tvg-id="{ch.get("tvg_id","")}\"'
            f' tvg-logo="{ch.get("logo","")}"'
            f' tvg-country="{ch.get("country","")}"'
            f' tvg-language="{ch.get("language","")}"'
            f' group-title="{ch.get("category","General")}"'
            f',{ch["name"]}'
        )
        lines.append(ch["url"])
    path = OUTPUT_DIR / "channels.m3u"
    path.write_text("\n".join(lines), encoding="utf-8")
    log.info(f"Wrote {path} ({path.stat().st_size / 1024:.1f} KB)")
    return path


# ── Main ──────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description="IPTV aggregator")
    parser.add_argument("--validate",    action="store_true", help="Validate stream URLs")
    parser.add_argument("--max",         type=int, default=0, help="Max channels (0=unlimited)")
    parser.add_argument("--skip-freetv", action="store_true")
    parser.add_argument("--skip-iptvorg",action="store_true")
    args = parser.parse_args()

    validate = args.validate or VALIDATE_STREAMS
    max_ch   = args.max or MAX_CHANNELS

    log.info("=== IPTV Aggregator starting ===")
    t0 = time.time()

    all_channels: list[dict] = []

    if not args.skip_freetv:
        all_channels.extend(fetch_free_tv())

    if not args.skip_iptvorg:
        all_channels.extend(fetch_iptv_org_index())

    log.info(f"Total fetched: {len(all_channels)} channels")

    # Deduplicate by (name+url) hash
    seen: set[str] = set()
    unique = []
    for ch in all_channels:
        cid = channel_id(ch)
        if cid not in seen:
            seen.add(cid)
            unique.append(ch)

    log.info(f"After dedup: {len(unique)} channels (removed {len(all_channels)-len(unique)} duplicates)")

    # Filter out NSFW
    clean = [c for c in unique if not c.get("nsfw")]
    log.info(f"After NSFW filter: {len(clean)} channels")

    # Validate (optional)
    if validate:
        clean = await validate_all(clean)
    else:
        for ch in clean:
            ch.setdefault("status", "unknown")

    # Enrich
    clean = [enrich_channel(ch, i) for i, ch in enumerate(clean)]

    # Sort
    clean.sort(key=lambda c: (c.get("country_name") or "zzz", c["name"].lower()))

    # Limit
    if max_ch and len(clean) > max_ch:
        log.info(f"Limiting to {max_ch} channels")
        clean = clean[:max_ch]

    # Write outputs
    write_json(clean)
    write_m3u(clean)

    elapsed = time.time() - t0
    log.info(f"=== Done in {elapsed:.1f}s — {len(clean)} channels written ===")


if __name__ == "__main__":
    asyncio.run(main())
