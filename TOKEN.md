# $FLYAI

$FLYAI is the token that funds [fly.ai](README.md). This document is the only place in this
repository where the token is described; the rest of the repo is about the fly.

**Contract address: not deployed yet.** When it is, the address appears here, on
[alextitonis.github.io/fly.ai](https://alextitonis.github.io/fly.ai) and on
[@flydotai](https://x.com/flydotai) — nowhere else. Any address from any other source is a scam.

| | |
|---|---|
| ticker | $FLYAI |
| chain | Robinhood Chain |
| launchpad | Bags |
| contract | not deployed yet |
| supply | 1,000,000,000 |
| liquidity | 100% of supply, LP tokens burned |
| team allocation | none |
| tax | none (no transfer tax; fees come from the launchpad) |
| mint / owner functions | disabled after launch |
| creator fees | 60% buys $FLYAI and burns it, 40% buys $MAGIC |
| $MAGIC contract | `0xF1572d1Da5c3CcE14eE5a1c9327d17e9ff0E3f43` |

## What it is

A funding token, and nothing more. **$FLYAI gives you no rights, no revenue share, no governance
and no claim on this project or its work.** It does not gate any part of the code: everything in
this repository is MIT-licensed and runs without it.

There is no staking, no emission schedule and no promise about price. The one mechanism the token
has is the buyback below, and it is mechanical: it runs on a schedule, not on anyone's judgement.
It is not a promise that the price will go anywhere.

## Launch

Fair launch. The entire supply goes into the liquidity pool at deployment, the LP tokens are
burned, and minting and owner privileges are renounced. There is no presale, no allocation, no
vesting schedule and no locked tranche to unlock later.

There is no team wallet. Any tokens the author holds are bought at launch from a public address,
which is published here on launch day and stays published. That is verifiable on-chain, which is
worth more than a vesting promise.

At launch this section will list:

* the contract address,
* the LP burn transaction,
* the author's public address.

## Fees and buyback

$FLYAI charges nothing on transfers. There is no tax, and no fee is taken from anyone holding or
trading the token. The only revenue is the **creator fee Bags pays on swaps**, which Bags
collects and sends to the creator address. Because that fee is external to the token
contract, the liquidity stays burned and the contract keeps no owner function that could change it.

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
As of now: **not deployed; nothing collected and nothing burned.**

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
