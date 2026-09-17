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

## Easy setup (no coding)

You need a computer that stays on while mining, a Bitcoin address or a pool account, and a wallet on Robinhood
Chain (MetaMask or Rabby) with some $FLYAI in it.

1. **Install Node.js:** download the LTS version from [nodejs.org](https://nodejs.org) and install it.
2. **Download this example:** on [the GitHub page](https://github.com/alextitonis/fly.ai), press **Code → Download
   ZIP** and unzip it. Open the folder `mine/examples/btc-pool`.
3. **Start it:**
   - **Windows:** double-click **`start-windows.bat`**.
   - **Mac:** double-click **`start-mac.command`**. If the Mac won't open it, open Terminal, type `bash `, drag the
     file into the window, and press Enter.
4. **Answer the questions:**
   - **The pool:** pick one. The first two need only your Bitcoin address.
   - **Your address:** paste your Bitcoin address, or your pool login if you use a pool with accounts.
   - **Your wallet:** paste your $FLYAI wallet address (starts with `0x`).
   - **Jobs:** how many to buy. It shows the price per job first.

   It checks that the pool answers before anything costs money.
5. **Pay:** your browser opens the payment page. Press **Pay**, sign in with the same wallet, and confirm in the
   wallet. The window notices the payment and starts mining.
6. **Keep the window open:** shares found and accepted show up there. Close it or press Ctrl+C to stop.

Start it again later and it picks up the same order. When the order runs out, it offers to make a new one. What
isn't spent goes back to your balance on the website.

Your answers and the order's key are saved in `my-setup.json` next to the start files. Keep that file private: the
key can add jobs to your order or stop it.

**Solo pools are a lottery:** they pay only when your miners find a whole Bitcoin block, and that's very unlikely
(see "What to expect" below). A pool with accounts pays a little for every share instead.

## Run it by hand

```sh
# 0. try the pool setup on this machine first: nothing is ordered or paid
node examples/btc-pool/bridge.ts --pool stratum+tcp://POOL:PORT --user YOUR_ACCOUNT.worker --local

# 1. a keep-open order for the hash search, opened with one small demo job
node examples/hash-search/make-inputs.ts --out first/
node examples/order.ts create --wallet 0x… --program examples/hash-search/hash_search.wasm --inputs first/ \
     --keep-open --redundancy 1 --timeout 240 --budget 20000
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

- **Share rate:** Solo CKPool's minimum difficulty is 10,000, about 43 trillion hashes per share, so 1,000 browser
  threads at 2.5 MH/s each find one about every 5 hours. Public Pool starts at 100,000, ten times harder.
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

- `start-windows.bat`, `start-mac.command`, `start.ts`: the guided setup.
- `stratum.ts`: the pool client, header building, targets, and the extranonce size check.
- `bridge.ts`: the loop, in `--local` mode or against an order.
- `mock-pool.ts`: a local pool that checks every share, for testing.
- `vectors.ts`: the genesis block as a Stratum job, and block 1.
- `test.ts` (`npm run test:btc-pool`) checks:
  - the genesis header rebuilt from Stratum parts matches byte for byte, and block 1 hashes right;
  - the program finds exactly the nonces a plain JavaScript search finds;
  - `--local` gets shares accepted by the mock pool;
  - the whole path works on a local chain: a paid order, a miner claiming and running jobs, results back to the
    bridge, and shares accepted;
  - the guided setup, answered like a person would: it makes the order, waits for payment, then mines.

**Real pools, checked on 2026-09-17:**
- `public-pool.io:3333` and `stratum.ckpool.org:3333` both connected and sent work that the bridge reads: 8-byte
  extranonce2, a 12-step merkle branch, and current difficulty bits.
- The previous-block hash Public Pool sent matched the chain tip on mempool.space once converted. That check found
  and fixed a byte-order bug that the mock pool alone couldn't catch, and it's now a test.
- No share was submitted to a real pool: at their difficulties that takes trillions of hashes. So the pool accepting
  a real share hasn't been seen yet.
