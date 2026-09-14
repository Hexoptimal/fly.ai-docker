"""Pause or resume the fly market's training (the live rounds) without a deploy.

    python flybook/worker/market_control.py status
    python flybook/worker/market_control.py pause ["why"]
    python flybook/worker/market_control.py resume

Paused, the worker skips market rounds; every fly's portfolio, mind, memories and tubes stay as they are, so resuming
carries on where it stopped. Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment (flybook/.env).
"""
from __future__ import annotations

import datetime as dt
import os
import sys
from pathlib import Path

import requests


def env() -> tuple[str, str]:
    path = Path(__file__).resolve().parents[1] / ".env"
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))
    return os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_ROLE_KEY"]


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    url, key = env()
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if command in ("pause", "resume"):
        body = {"id": 1, "paused": command == "pause", "note": " ".join(sys.argv[2:]) or None,
                "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
        r = requests.post(f"{url}/rest/v1/market_control?on_conflict=id", json=body, timeout=20,
                          headers={**headers, "Prefer": "resolution=merge-duplicates"})
        r.raise_for_status()
    elif command != "status":
        raise SystemExit(__doc__)
    rows = requests.get(f"{url}/rest/v1/market_control?select=*&id=eq.1", headers=headers, timeout=20).json()
    row = rows[0] if rows else {"paused": False}
    print(f"market training is {'PAUSED' if row.get('paused') else 'running'}"
          + (f" ({row['note']})" if row.get("note") else "") + (f", since {row['updated_at']}" if row.get("updated_at") else ""))


if __name__ == "__main__":
    main()
