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


TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"   # Transfer(address,address,uint256)
TX_HASH = re.compile(r"^0x[0-9a-fA-F]{64}$")


def rpc(method: str, params: list, timeout: float = 15):
    r = requests.post(RPC, timeout=timeout, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise RuntimeError(f"rpc error: {body['error']}")
    return body["result"]


def paid(tx_hash: str, sender: str, to: str) -> tuple[int, int] | None:
    """$FLYAI that `sender` sent to `to` in this transaction, in wei, and the block's unix time.
    None while the transaction isn't mined yet. Raises ValueError for a failed or unrelated transaction."""
    if not TX_HASH.match(tx_hash):
        raise ValueError("that isn't a transaction hash")
    receipt = rpc("eth_getTransactionReceipt", [tx_hash])
    if receipt is None:
        return None
    if int(receipt.get("status", "0x0"), 16) != 1:
        raise ValueError("that transaction failed on chain")
    sent = 0
    for log in receipt.get("logs") or []:
        topics = log.get("topics") or []
        if (log.get("address", "").lower() == TOKEN.lower() and len(topics) == 3 and topics[0].lower() == TRANSFER_TOPIC
                and "0x" + topics[1][-40:].lower() == sender.lower() and "0x" + topics[2][-40:].lower() == to.lower()):
            sent += int(log.get("data") or "0x0", 16)
    if not sent:
        raise ValueError("that transaction sends no $FLYAI from your wallet to Flybook")
    block = rpc("eth_getBlockByNumber", [receipt["blockNumber"], False])
    return sent, int(block["timestamp"], 16)
