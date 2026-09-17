# kaspa: GPU mining as a compute program

`khh.wgsl` is [kHeavyHash](https://github.com/kaspanet/rusty-kaspa), Kaspa's proof-of-work, as a WebGPU compute
shader: each job searches a nonce range and returns the nonces whose hash met the pool's target. `bridge.ts` holds
the pool connection and feeds those ranges to a keep-open **house order**, so the coins go to the project and the
miners running it earn their usual points.

```
pool ──mining.notify──▶ bridge ──matrix + nonce ranges (jobs)──▶ house order ──▶ miners' GPUs
pool ◀──mining.submit── bridge ◀──nonces that met the target── results ◀────────┘
```

## What it earns: almost nothing, and that is the point

Measured on an RTX 4060, the shader does **11.2 MH/s**, about **2% of what the same card does natively** — WGSL
has no 64-bit integers, so every keccak lane is emulated with a pair of 32-bit words. Kaspa's network is
ASIC-dominated (one KS5 Pro is worth about 42,000 RTX 4060s), so a browser's share is a fraction of a cent a year.

It was built anyway because it is the only GPU proof-of-work with a published specification **and test vectors**,
which makes it the honest way to prove the whole path — pool, matrix, jobs, miners, verified shares — with a
shader that can be swapped for a better-paid one when a worthwhile coin appears. The CPU side
([yespower](../yespower-pool)) earns about a thousand times more per machine.

## How one hash works

1. `cSHAKE256("ProofOfWorkHash")` over `prePowHash || timestamp || 32 zero bytes || nonce`. The input is exactly
   one block, so it is a single keccak-f1600 from a precomputed state.
2. A 64×64 matrix of nibbles times the 64 nibbles of that hash; each pair of rows gives one output byte, which is
   then xored with the original.
3. `cSHAKE256("HeavyHash")` over the result, again one permutation.
4. Compare with the target as a little-endian 256-bit number.

The matrix comes from the pre-pow hash through xoshiro256++, redrawn until it has full rank. That rank check is
64-bit floating point, which WGSL hasn't got, so the bridge builds the matrix once per job (in `khh.ts`) and ships
it in the job's input.

## Files

| File | What it is |
|---|---|
| `khh.wgsl` | the shader miners run |
| `khh.ts` | the same algorithm in TypeScript: the bridge re-checks every hit with it, and the tests compare |
| `job.ts` | the job's input and output layout |
| `stratum.ts` | Kaspa's flavour of Stratum, including the extranonce prefix rule |
| `bridge.ts` | pool ↔ house order |
| `mock-pool.ts` | a pool that judges shares with kHeavyHash, for tests |
| `vectors.json` | rusty-kaspa's own test vectors, lifted from its `matrix.rs` tests |

## Running it

```
node examples/kaspa/bridge.ts --pool stratum+tcp://HOST:PORT --user kaspa:ADDRESS[.WORKER] --admin $ADMIN_TOKEN
node examples/kaspa/bridge.ts --pool ... --user ... --local       # search here instead, to check a pool
node examples/kaspa/bench.ts --groups 1024 --per-thread 64        # hashrate on this machine's GPU
npm run test:kaspa                                                # vectors, shader vs reference, bridge vs pool
```

Pools that take a wallet address with no account: Kryptex (`kas.kryptex.network:7011`, 10 KAS minimum),
HeroMiners (`kaspa.herominers.com:1206`), WoolyPooly, 2Miners.

## Checks

`npm run test:kaspa` runs four things: the TypeScript implementation against rusty-kaspa's published vectors (the
heavy hash, and the matrix a hash generates, rank check and all); the shader on this machine's GPU finding exactly
the nonces the reference finds, with identical hashes; the hashrate; and the bridge getting a share accepted by a
mock pool, extranonce prefix and all.

The order runs at redundancy 1. Two GPUs agree on *which* nonces qualify but not on the order an atomic counter
hands out slots, so their outputs differ byte for byte. That costs nothing: the bridge re-hashes every hit before
submitting, so a miner can hide a share but never invent one.
