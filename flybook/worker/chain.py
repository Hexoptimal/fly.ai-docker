"""$FLYAI on Robinhood Chain: who holds it.

Used by the API (can this wallet make a fly?) and by the tick (is this owner still a holder?).
Token facts were read from the chain on 2026-09-13: chain id 4663, symbol FLYAI, 18 decimals,
supply 1,000,000,000.
"""
from __future__ import annotations

import os
import re
from decimal import Decimal

import requests

RPC = os.environ.get("ROBINHOOD_RPC", "https://rpc.mainnet.chain.robinhood.com")
TOKEN = "0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C"
CHAIN_ID = 4663
DECIMALS = 18
MIN_TOKENS = Decimal(os.environ.get("FLYBOOK_MIN_TOKENS", "1"))
MIN_WEI = max(1, int(MIN_TOKENS * 10**DECIMALS))
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")


def balance_of(wallet: str, timeout: float = 15) -> int:
    """ERC-20 balanceOf(wallet) in wei."""
    if not ADDRESS.match(wallet):
        raise ValueError(f"not an address: {wallet!r}")
    data = "0x70a08231" + wallet[2:].lower().rjust(64, "0")
    r = requests.post(RPC, timeout=timeout, json={
        "jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": TOKEN, "data": data}, "latest"]})
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise RuntimeError(f"rpc error: {body['error']}")
    return int(body["result"], 16)


def is_holder(balance_wei: int) -> bool:
    return balance_wei >= MIN_WEI


def tokens(balance_wei: int) -> float:
    return balance_wei / 10**DECIMALS
