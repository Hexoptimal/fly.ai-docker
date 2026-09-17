# yespower-pool: mine a yespower coin for the project

A bridge between a Stratum v1 mining pool and a fly.ai **house order**. Miners run
[`yespower_search.wasm`](../yespower) in their browsers; the bridge does everything else, and the coins go to the
project's address.

```
pool ──mining.notify──▶ bridge ──headers, nonce ranges (jobs)──▶ house order ──▶ miners
pool ◀──mining.submit── bridge ◀──nonces that met the share target── results ◀──┘
```

Unlike [btc-pool](../btc-pool), which spends a buyer's paid order, this one is our own work: a house order, no
payment, and miners earn their usual points (times `PROGRAM_BONUS`) for running it.

## Why yespower

It is the only CPU proof-of-work worth running in a browser. RandomX (Monero) needs a runtime JIT and a 2 GB
dataset, so a browser pays about 30x over native. yespower needs neither: 2 MB of scratchpad, plain integer work.
Measured in our own sandbox, one thread does **243 H/s** at yescrypt's parameters, roughly a third of native.

What that is worth, at pool rates (zpool, September 2026, and its 24-hour average agreed):

| Algorithm | H/s per thread | $ per 8-thread machine-day |
|---|---|---|
| `yescrypt` (yespower 0.5, r=8) | 243 | **$0.020–0.023** |
| `yespowerTIDE` | 329 | $0.012 |
| `yespowerR16` | 83 | ~$0 |
| `yespowerSUGAR` | 86 | ~$0 |

Two cents per machine-day. It is not a business; it is the best that exists for donated browser CPU, and it needs
no buyers. Read [the compute API guide](../../web/compute-api.md) if you want the paid path instead, which is worth
far more per machine.

## Running it

```
node examples/yespower-pool/bridge.ts --pool stratum+tcp://HOST:PORT --user ADDRESS[.WORKER] \
     --coin yescrypt --admin $ADMIN_TOKEN [--server https://flyai-mine.fly.dev] [--per-job 20000] [--ahead 16]
```

- **`--user`** is the payout address the pool pays. Multi-coin pools (zpool, zergpool) take a wallet address as the
  login and need no account.
- **`--coin`** picks the parameters (see `COINS` in [hash.ts](hash.ts)): version, N, r and the personalization
  string. A coin that isn't listed needs its parameters added there.
- **`--admin`** is the mining server's `ADMIN_TOKEN`: the bridge opens a keep-open house order named
  `mining/<coin>` the first time and carries on with it afterwards.
- **`--local`** skips the network and mines on this machine, to check a pool before pointing the fleet at it.

The bridge re-hashes every hit before submitting it, so a miner cannot get a false share sent to the pool. It can
only hide one, which costs it points and nothing else. Nobody can steal the reward either: the header commits to
the pool's coinbase.

## Sizing

A browser thread does roughly 250 hashes a second, so `--per-job 20000` is about a minute and a half of work.
Keep `--ahead` modest: jobs still queued when the pool moves to a new block are wasted.

## Tests

```
npm run test:yespower     # the hasher against the reference vectors, then the bridge, then the whole path
```

Four parts: the WebAssembly hasher reproduces yespower's own published vectors; the nonce search finds exactly the
hits a full scan finds and reports honest hashes; the bridge gets a share accepted by a mock pool that judges it
with yespower; and the complete path (house order → miner → result → share) works against a local server.
