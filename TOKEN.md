# $FLYAI

$FLYAI is the token that funds [fly.ai](README.md). This document is the only place in this
repository where the token is described; the rest of the repo is about the fly.

**Contract address: `0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C`** (Robinhood Chain). It is published here, on
[alextitonis.github.io/fly.ai](https://alextitonis.github.io/fly.ai) and on
[@flydotai](https://x.com/flydotai) — nowhere else. Any address from any other source is a scam.

| | |
|---|---|
| ticker | $FLYAI |
| chain | Robinhood Chain |
| launchpad | [Pons](https://www.ponsfamily.com/launchpad/0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C) |
| explorer | [Blockscout](https://robinhoodchain.blockscout.com/token/0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C) |
| contract | `0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C` |
| supply | 1,000,000,000 |
| pair | NVDA (bonding curve, then Uniswap V4) |
| liquidity | bonding curve -> Uniswap V4; the pool position is locked permanently by Pons |
| locker | `0x267444d099b10fb5ed7c3cc7b7c767adca574952` (Pons launch locker; also holds 81,632,653 FLYAI, 4/49 of supply, permanently) |
| team allocation | none (the developer bought 0.156314 NVDA worth on the curve at launch, like anyone else) |
| tax | none (no transfer tax; fees come from the launchpad) |
| mint / owner functions | disabled after launch |
| creator fees | 60% buys $FLYAI and burns it, 40% buys $MAGIC |
| $MAGIC contract | `0xF1572d1Da5c3CcE14eE5a1c9327d17e9ff0E3f43` |

## What it is

$FLYAI funds fly.ai, and it is the currency of the shared world (see *The world* below).

**It gives you no rights, no revenue share, no governance and no claim on this project, its work
or its earnings.** The research stays free: every line of code in this repository is MIT-licensed
and runs on your own machine without the token, forever. What the token buys is a place in the
shared simulation that we host, nothing else.

There is no staking, no emission schedule and no promise about price. The only automatic mechanism
is the buyback below, and it runs on a schedule rather than on anyone's judgement. It is not a
promise that the price will go anywhere.

## The world

fly.ai is building one persistent 3-D world where flies driven by the connectome live, forage,
mate, age and die. It is shared: everyone watches the same world.

$FLYAI is what you spend in it.

* **Create a faction.** A faction is a colour. Its flies carry that colour, and they are yours to
  watch.
* **Feed it.** Spend again to drop food into the world for your faction.
* **It can die.** A faction can be wiped out entirely - by luck, by predators, by starvation, or
  because its flies simply do not do well. Extinction is permanent and real. Nothing you pay
  guarantees survival, and anyone telling you otherwise is wrong.

What separates one faction from another is meant to be its **brain settings** - the fly's sensory
gains and wiring seed - so the world doubles as a live experiment in which settings actually
survive. That is the point of it, and it is also why no amount of feeding makes a faction safe.

This is not built yet. It is the roadmap, written down before launch rather than after, and none
of it is a promise of a return.

## Launch

Fair launch on Pons. Trading starts on a bonding curve; once it has taken enough liquidity the
token graduates to a Uniswap V4 pool and **the pool's liquidity position is locked permanently in
the Pons launch locker** (`0x267444d099b10fb5ed7c3cc7b7c767adca574952`), so the liquidity cannot be
withdrawn by anyone, including us. The same contract permanently holds 4/49 of the supply
(81,632,653 FLYAI), which never unlocks. Minting and owner
privileges are renounced. There is no presale, no allocation, no vesting schedule and no locked
tranche to unlock later.

There is no team wallet. Any tokens the author holds are bought at launch from a public address,
which is published here on launch day and stays published. That is verifiable on-chain, which is
worth more than a vesting promise.

At launch this section will list:

* the contract address,
* the liquidity locker address,
* the author's public address.

## Fees and buyback

$FLYAI charges nothing on transfers. There is no tax, and no fee is taken from anyone holding or
trading the token. The only revenue is the **creator fee the launchpad pays on swaps**, which Pons
collects and sends to the creator address. Because that fee is external to the token
contract, the liquidity stays locked and the contract keeps no owner function that could change it.

That revenue is split:

* **60% buys $FLYAI on the open market and burns it.** The tokens go to the burn address and leave
  the supply permanently. They are not held, not re-sold and not kept in a treasury.
* **40% buys $MAGIC**, the token of the company behind fly.ai, at
  `0xF1572d1Da5c3CcE14eE5a1c9327d17e9ff0E3f43`. fly.ai is built by that
  team, and this is the share that flows up to it.

The buyback runs **weekly, on a fixed schedule**, from a single public address. Timing is not
discretionary — waiting for a good price would mean trading against the people holding the token.
The split is executed by hand rather than enforced by a contract, so it rests on the fee wallet
being public: every cycle is posted with its transaction hashes, and the wallet can be watched
whether or not anything is announced.

At launch this section will list the fee address, the burn address and the running total burned.
As of launch day (12 September 2026): **deployed; nothing collected and nothing burned yet.**

## Funding the work

Compute for this project (GPU time for the brain, training runs for readout and rewiring
experiments) is paid for out of pocket. The creator fee is fully committed to the 60/40 split
above, so it does not fund the work and there is no treasury holding $FLYAI.

If a treasury is ever created, it will be a single named address published here, capped at 5% of
supply, and every outflow will be logged in this file with date, amount and what it bought — the
same way the research results are reported, including the ones that did not work.

As of now: **no treasury exists and no treasury tokens have been created.**

## Bounties

The experiments in this project have published numbers, and anyone can reproduce them from the
recordings in [sshfighter/](sshfighter/). Where a benchmark is worth beating, a bounty in $FLYAI
may be posted for beating it, paid on a reproducible result merged into this repository.

Open bounties are listed here. As of now: **none.**

## Disclaimer

$FLYAI is not an investment, and nothing here is financial advice. The token confers no ownership,
no rights and no entitlement to anything. Crypto assets are volatile and you can lose everything
you put in. Do your own research and only spend what you can afford to lose.

The research in this repository stands on its own and is published under the MIT License whatever
the token does.
