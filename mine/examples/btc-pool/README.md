# btc-pool: mine at a Bitcoin pool with fly.ai compute

A bridge between a Stratum v1 mining pool and a fly.ai compute order. Miners run
[`hash_search.wasm`](../hash-search) in their browsers; the bridge does everything else.

```
pool ──mining.notify──▶ bridge ──headers, nonce ranges (jobs)──▶ fly.ai order ──▶ miners
pool ◀──mining.submit── bridge ◀──nonces that meet the share target── results ◀──┘
```

1. **Work:** the bridge connects to the pool and, for each pool job, builds block headers: the coinbase with a fresh
   extranonce2, its merkle root, and the rest. A header has 4 billion nonces, which it cuts into ranges.
2. **Jobs:** each range becomes one job input, added to your keep-open order (`POST /api/orders/:id/jobs`).
3. **Results:** each settled job lists the nonces whose hash met the pool's share target. The bridge hashes each one
   again itself, then submits it to the pool.
4. **Payouts:** the pool credits its account, your `--user`, and pays you as it normally does.

**Miners can't take the reward.** The header commits to the pool's coinbase transaction. A nonce found for that
header counts only there, and changing the coinbase changes the header.

## Run it

```sh
# 0. try the pool setup on this machine first: nothing is ordered or paid
node examples/btc-pool/bridge.ts --pool stratum+tcp://POOL:PORT --user YOUR_ACCOUNT.worker --local

# 1. a keep-open order for the hash search, opened with one small demo job
node examples/hash-search/make-inputs.ts --out first/
node examples/order.ts create --wallet 0x… --program examples/hash-search/hash_search.wasm --inputs first/ \
     --keep-open --redundancy 1 --timeout 120 --bid 40 --budget 20000
node examples/order.ts pay --order ORDER_ID --tx 0x…

# 2. the bridge
node examples/btc-pool/bridge.ts --pool stratum+tcp://POOL:PORT --user YOUR_ACCOUNT.worker \
     --order ORDER_ID --key ORDER_KEY --per-job 200000000 --ahead 8
```

| Flag | Default | |
|---|---|---|
| `--pool` | required | `stratum+tcp://host:port` |
| `--user`, `--pass` | required, `x` | the pool login. Solo pools take a Bitcoin address |
| `--order`, `--key` | required unless `--local` | the keep-open order and its order key |
| `--per-job` | 1,000,000,000 (20,000,000 local) | nonces per job. A browser thread does very roughly 2–3 million a second |
| `--ahead` | 8 | jobs kept waiting. Jobs queued when the network finds a block are wasted |
| `--extranonce2-bytes` | read from the coinbase | set it if detection fails |
| `--server` | `https://flyai-mine.fly.dev` | the fly.ai API |

Every 30 seconds it logs jobs, hashes, the hash rate, and accepted, rejected and stale shares.

## What to expect

A share at difficulty `d` takes `d × 4.3 billion` hashes on average.

- **Share rate:** a pool that starts you at difficulty 10,000 needs about 43 trillion hashes per share. 1,000 browser
  threads at 2.5 MH/s each find one about every 5 hours.
- **Earnings:** the pool pays for shares, and the Bitcoin network is very roughly 10²¹ hashes a second. Browser
  hashing earns a tiny fraction of what the jobs cost, so treat this as the pattern for pool mining, not as income.
- **Other coins:** coins with other proofs of work need their own hash function compiled into a program in place of
  `hash_search.wasm`, and their own header layout in `stratum.ts`.
- **Redundancy:** at redundancy 1 a dishonest miner can't fake a share (every hit is hashed again), but it can hide
  one by reporting none. Redundancy 2 stops that for twice the price.
- **Upload limits:** each job is one uploaded 116-byte input. Uploads are limited per address (600 an hour), which
  caps a bridge at about 10 new jobs a minute. Use a big `--per-job`.
- **Not supported:** version rolling (AsicBoost), `mining.configure`, reconnects (the bridge exits when the pool
  closes the connection; restart it), and Stratum v2.

## Files

- `stratum.ts`: the pool client, header building, targets, and the extranonce size check.
- `bridge.ts`: the loop, in `--local` mode or against an order.
- `mock-pool.ts`: a local pool that checks every share, for testing.
- `vectors.ts`: the genesis block as a Stratum job, and block 1.
- `test.ts` (`npm run test:btc-pool`) checks:
  - the genesis header rebuilt from Stratum parts matches byte for byte, and block 1 hashes right;
  - the program finds exactly the nonces a plain JavaScript search finds;
  - `--local` gets shares accepted by the mock pool;
  - the whole path works on a local chain: a paid order, a miner claiming and running jobs, results back to the
    bridge, and shares accepted.

Tested only against the mock pool, not against a real one.
