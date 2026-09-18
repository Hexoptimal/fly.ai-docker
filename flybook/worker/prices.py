"""Real prices for the fly market: an allowlist of Robinhood Chain tokens, priced in USD from their live pools.

The flies paper-trade these with paper USDG: nothing is bought or sold on chain. Picked 2026-09-18 (at most 20) from
Robinhood Chain's most traded pools on GeckoTerminal: the chain's ETH; its ecosystem and meme tokens with weeks of history, steady volume and $1M+ of liquidity ($FLYAI is ours and smaller); and
Robinhood's tokenized stocks and ETFs, only the official ones named "<company> • Robinhood Token" on chain.
Left out on purpose: WALLET (a scam token), TheGreenHood (0xdaa8…, a meme with the HOOD ticker), every SPCX/SpaceX
token (not an official Robinhood token, many copycats), COIN (made room for USDG; the thinnest stock token), and memes
launched within the last week with large liquidity but thin volume.
USDG, the chain's main dollar and the same dollar the flies' cash is held in, is on the list as a place to park: it barely
moves, so when most tokens fall it is often the only one that looks like it's rising, and a fly turns toward it.

Prices: DexScreener (each token's most liquid pair, one call for all tokens), with GeckoTerminal's token prices
filling any gap (GeckoTerminal alone froze thinly traded tokens for hours). A token neither answers keeps its last price for that round; the round is skipped if none answer.
"""
from __future__ import annotations

import requests

# symbol, name, address (Robinhood Chain, chain id 4663), category
TOKENS = [
    ("ETH", "Ether", "0x0bd7d308f8e1639fab988df18a8011f41eacad73", "major"),          # WETH
    ("FLYAI", "fly.ai", "0x0088ce7905025c4b5ea1d49ab6179b6aaadb3b9c", "meme"),
    ("PONS", "Pons", "0x39dbed3a2bd333467115de45665cc57f813c4571", "meme"),
    ("AI", "Artificial Inu", "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18", "meme"),
    ("MEME", "A Meme Coin", "0x385f4f8ae47651ce5f58f5265395a669f8281e18", "meme"),
    ("CASHCAT", "Cash Cat", "0x020bfc650a365f8bb26819deaabf3e21291018b4", "meme"),
    ("BLORB", "BLORB", "0x4d14284afe559b7c6b9e6fad6ebaeaa0f6051818", "meme"),
    ("NVDA", "NVIDIA", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", "stock"),
    ("TSLA", "Tesla", "0x322f0929c4625ed5bad873c95208d54e1c003b2d", "stock"),
    ("AAPL", "Apple", "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", "stock"),
    ("MSFT", "Microsoft", "0xe93237c50d904957cf27e7b1133b510c669c2e74", "stock"),
    ("AMZN", "Amazon", "0x12f190a9f9d7d37a250758b26824b97ce941bf54", "stock"),
    ("GOOGL", "Alphabet", "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", "stock"),
    ("META", "Meta Platforms", "0xc0d6457c16cc70d6790dd43521c899c87ce02f35", "stock"),
    ("MSTR", "Strategy", "0xec262a75e413fafd0df80480274532c79d42da09", "stock"),
    ("CRCL", "Circle", "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5", "stock"),
    ("SPY", "S&P 500 ETF", "0x117cc2133c37b721f49de2a7a74833232b3b4c0c", "stock"),
    ("QQQ", "Nasdaq-100 ETF", "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68", "stock"),
    ("GLD", "Gold ETF", "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e", "stock"),
    ("USDG", "Global Dollar", "0x5fc5360d0400a0fd4f2af552add042d716f1d168", "stable"),   # the chain's main dollar
]
BY_SYMBOL = {t[0]: t for t in TOKENS}
BY_ADDRESS = {t[2]: t[0] for t in TOKENS}
GECKO = "https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/multi/"
DEXSCREENER = "https://api.dexscreener.com/tokens/v1/robinhood/"


def _gecko(timeout: float) -> dict[str, float]:
    r = requests.get(GECKO + ",".join(BY_ADDRESS), timeout=timeout, headers={"accept": "application/json"})
    r.raise_for_status()
    out = {}
    for t in r.json().get("data", []):
        a = t.get("attributes") or {}
        symbol = BY_ADDRESS.get((a.get("address") or "").lower())
        if symbol and a.get("price_usd"):
            out[symbol] = float(a["price_usd"])
    return out


def _dexscreener(addresses: list[str], timeout: float) -> dict[str, float]:
    r = requests.get(DEXSCREENER + ",".join(addresses), timeout=timeout, headers={"accept": "application/json"})
    r.raise_for_status()
    best: dict[str, tuple[float, float]] = {}                  # symbol -> (liquidity, price)
    for p in r.json() or []:
        symbol = BY_ADDRESS.get(((p.get("baseToken") or {}).get("address") or "").lower())
        if not symbol or not p.get("priceUsd"):
            continue
        liquidity = float((p.get("liquidity") or {}).get("usd") or 0)
        if symbol not in best or liquidity > best[symbol][0]:
            best[symbol] = (liquidity, float(p["priceUsd"]))
    return {s: price for s, (_, price) in best.items()}


def fetch(timeout: float = 12) -> dict[str, float]:
    """USD price of every allowlisted token that either source answers for. Never raises; {} if both fail.
    DexScreener first (its most liquid pair, live); GeckoTerminal fills gaps. GeckoTerminal was the first source
    until 2026-09-18, when its prices for thinly traded tokens (FLYAI, BLORB) turned out to be frozen for hours."""
    prices: dict[str, float] = {}
    try:
        prices.update(_dexscreener([t[2] for t in TOKENS], timeout))
    except Exception as e:
        print(f"prices: DexScreener failed ({type(e).__name__}: {e})", flush=True)
    if len(prices) < len(TOKENS):
        try:
            for s, p in _gecko(timeout).items():
                prices.setdefault(s, p)
        except Exception as e:
            print(f"prices: GeckoTerminal failed ({type(e).__name__}: {e})", flush=True)
    return {s: p for s, p in prices.items() if p > 0}


if __name__ == "__main__":
    got = fetch()
    for symbol, name, _, category in TOKENS:
        print(f"{symbol:7} {category:6} {name:28} {got.get(symbol, 'n/a')}")
