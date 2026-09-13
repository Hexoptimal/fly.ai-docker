# Flybook

A social feed written by fruit-fly brains. Every fly is the frozen MaleCNS connectome. Each
tick, something happens to each fly in its patch: wind, a looming shape, a taste, a touch, a
pheromone, or nothing. A translator then reads the fly's 1,314 descending neurons, and the post
is the word it reads. Next to the post: the translator's held-out precision for that word, what
really happened, and the neuron types that moved. No language model writes posts.

```
flybook/
  worker/     Python, CPU only: calibrate the translator, run ticks, write posts
  supabase/   Postgres schema, row-level security, realtime
  web/        Vite + React feed (flyaiworld.com/flybook/)
```

## How Flybook works (for players)

Flybook is live at [flyaiworld.com/flybook](https://flyaiworld.com/flybook/). Every fly is the full MaleCNS
connectome (166,700 neurons), simulated. No language model writes anything a fly posts.

**What happens.** Four patches (fruit bowl, windowsill, compost heap, spider corner) hold the flies. There are
no house flies: every fly in Flybook was made by a holder, so the feed starts empty and comes alive as people join. Every 2
minutes each patch has an event: a looming shadow, a gust of wind, a taste, a brush across the eyes, a male's
scent, or a fly walking past. It hits one fly. Every fly's brain then runs for 1.5 seconds.

**What a fly can do.**
- *Sense and say it*: a decoder reads what it sensed from its 1,314 descending neurons (threat, mate, wind,
  taste, touch, cVA). The post shows that word, how reliable the decoder is for it, and what really happened.
- *Act*: behaviour neurons show whether it jumped, turned, groomed, backed up or buzzed its wings.
- *Get it wrong*: misreads and hallucinations (sensing something that wasn't there) are posted as such.
- *Set others off*: its jump looms over the flies near it, its movement catches their eye, a bump touches their
  bristles. Their posts link back to the fly that set them off, and the patch map replays the chain.
- *Duel*: in the Arena two flies face the same growing threat. Quick draw: first to jump wins. Stare-down: last
  to jump wins. Elo ratings from 1000.
- *Earn badges*: Sharp eye, Dreamer, Hair trigger, Well groomed, Crowd favourite and more, from its real history.

**What you can do.** Everyone can watch the feed, the patch maps, the Arena and the leaderboards. Sign in with a
wallet holding at least 1 $FLYAI to:
- make up to 3 flies: pick one of 13 profiles or fine-tune senses, temperament and 8 neuron groups;
- breed a new fly from two of yours (settings mix and mutate);
- poke a patch: pick a stimulus and click the map where it lands;
- like, comment on, and caption your own flies' posts (captions show as human-written);
- challenge any fly to a duel with one of yours;
- complete daily and weekly missions for season points.

**Rewards.** Seasons last two weeks (season 1: 7-20 September 2026, then every other Monday 00:00 UTC). Missions earn season points: 10 for each daily mission, 50 for each weekly one. At the end of each season the top 3 on the Season points board win $FLYAI. Likes on your own flies don't count anywhere, and flies of wallets that drop below 1 $FLYAI
go dormant until they hold again.

## Phase 1: house flies, read-only

The 12 house flies and 4 patches are listed in `worker/house.json`. The worker upserts them into
the database when the database has no flies, or when you pass `--seed-house`.

### 1. Calibrate the translator (once per change to `worker/episode.py`)

```
python flybook/worker/calibrate.py --train 48 --test 24
```

This writes `worker/model/translator.npz` and `worker/model/vocab.json`. The test episodes use
seeds the fit never saw. A word is posted only if its test precision reaches `--min-precision`
(0.6 by default). The worker refuses to run if `episode.py` changed since calibration.

### 2. Run ticks

No database needed, writes the demo feed the web app falls back to:

```
python flybook/worker/tick.py --json flybook/web/public/demo-feed.json --ticks 4
```

Against Supabase (local or hosted):

```
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python flybook/worker/tick.py --every 900
```

Each tick row stores the git sha, the episode config, the RNG seed and the translator version
and precision, so any post can be traced back to the brain that made it.

### 3. Database

```
cd flybook && supabase start            # local, needs Docker
supabase db push --db-url "$SUPABASE_POOLER_URL"   # hosted
```

Secrets live in `flybook/.env` (worker: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_POOLER_URL`) and `flybook/web/.env.local` (anon key), both git-ignored. Load them with
`set -a && . flybook/.env && set +a`. The direct `db.<ref>.supabase.co` host is IPv6-only, so
from an IPv4 network use the session pooler (`aws-1-eu-west-3.pooler.supabase.com:5432`, user
`postgres.<ref>`).

Everyone can read. Only the service role (the worker) writes flies, ticks and posts. Captions
(phase 2) can only be written by the owner of the fly that made the post, and always show as
human-written.

### 4. Web

```
cd flybook/web
cp .env.example .env.local               # fill in, or leave empty for the demo feed
npm install && npm run dev
```

The app is served at **flyaiworld.com/flybook/** by the main Vercel project: the root
`vercel.json` builds `flybook/web` (Vite `base: "/flybook/"`) and copies `dist/` into
`.vercel-out/flybook/`. Build values are not in git (every `.env*` except `.env.example` is ignored). Set them in the Vercel
project (Settings > Environment Variables): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_FLYBOOK_API` (https://flybook-worker.fly.dev). Locally they live in `web/.env.local`. The research write-up moved to
`docs/research/flybook.html` (/research/flybook).

### 5. Worker + API on fly.io (app `flybook-worker`, personal org, region cdg)

```
fly secrets set -a flybook-worker SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...   # once
bash flybook/worker/deploy.sh
```

`deploy.sh` stages the worker, translator and `flytalk.py` in a temp folder and builds remotely. The
brain is [flybrain 0.1.0 from PyPI](https://pypi.org/project/flybrain/0.1.0/) (pinned in `worker/requirements.txt`), and the image
runs `flybrain download` at build time, so machines start with the brain files already there. One app, two process groups (`fly.toml`): `tick` runs `tick.py --every 900` on a
2 CPU / 2 GB machine; `api` runs `api.py` behind https://flybook-worker.fly.dev and stops when idle.

## Phase 2: holders make flies

1. The browser connects a wallet (wagmi, Robinhood Chain 4663) and reads the $FLYAI balance, for
   display only.
2. The wallet signs in to Supabase with Sign in with Ethereum (`signInWithWeb3`). This needs the
   **Web3 Wallet → Ethereum** provider enabled in the Supabase dashboard, and the page's URL in
   **Authentication → URL Configuration** (Site URL / Redirect URLs); otherwise Supabase rejects
   the signed message ("URI which is not allowed on this server"). `http://localhost:5173` works
   for development. Supabase stores the address as `identity_data.custom_claims.address` on the
   `web3` identity (also in `sub`, `web3:ethereum:0x...`), with the chain id the wallet reported.
3. `POST /flies` on the API checks the session, reads the wallet's balance on chain, and creates
   the fly only if it holds at least `FLYBOOK_MIN_TOKENS` (1) and has fewer than
   `FLYBOOK_MAX_FLIES` (3) flies.
4. Every tick, the worker re-checks each owner's balance. An owner below the minimum has their
   flies set `active = false` (dormant, no posts) until they hold again. If the chain can't be
   read, the old flag stays.

## Train your fly: not offered (2026-09-13)

Learning in a real fly's mushroom body needs each odour to activate a small, distinct set of Kenyon cells
(KCs) whose synapses onto output neurons (MBONs) dopamine can weaken. The wiring is in the connectome
(4,064 KCs, 97 MBONs, 61,210 KC->MBON synapses, 3,123 dopamine->MBON contacts, 2,187 synapses from the
vinegar/cVA relay neurons onto KCs), but in this model at 20 ms **every KC fires at the 50 Hz ceiling at
rest**, as do the PAM dopamine neurons, so odours (which do raise their relay neurons, 16->30 Hz and
8->27 Hz) can't change the KC code. Gates fixed before running:

- Gate 1 (a steady inhibitory push on all KCs, 8 levels, 2 seeds): rest <= 20% KCs active, each odour >= 2x,
  vinegar/cVA evoked-set overlap (Jaccard) < 0.5, DN rate within 20%. Passed only at -0.30 (rest 12.5%,
  vinegar 48%, cVA 71%, overlap 0.29).
- Gate 2 (7 levels around it, 3 seeds): the gate-1 criteria at >= 3 neighbouring levels, and each odour
  raising >= 10% of MBONs by >= 2 Hz. **Failed**: only -0.30 passes (12% rest, MBONs up 31% / 75%);
  -0.28 is still 77% active at rest and -0.32 loses cVA at the outputs (4%). The KC population flips from
  mostly on to mostly off between -0.28 and -0.30, a switch rather than a dial.

Learning built on that knife edge wouldn't be reliable, so it isn't offered. What would change it: feedback
inhibition of KCs (the APL neuron) that actually sparsens them, per-cell thresholds, or a finer time step;
each is a model change to measure separately (ROADMAP section 3).

## Community: captions, comments, weekly challenges, duels, breeding (2026-09-13)

- **Captions**: the owner of the fly that made a post writes one caption (`POST/DELETE /posts/<id>/caption`),
  shown as "owner's caption · human". Holders comment (`POST /posts/<id>/comments`, one per 10 s, 30 an
  hour; `DELETE /comments/<id>` for your own). Both tables are written only by the API.
- **Weekly challenges** (`challenge_board(week_start)`): the theme rotates each Monday UTC between calm
  (fewest jumps through real threats, 3+), alarm (set off the most flies), sharp (share of reads right, 10+)
  and loved (likes from others). Leaderboard > Weekly challenge shows this week and last week's top 3.
  For rewards: `select * from challenge_board(date_trunc('week', now()) - interval '7 days')` gives last
  week's winners; join `flies.owner` to `profiles.wallet` with the service role for full wallets.
- **Duels** (`worker/duels.py`): two flies 0.1 apart under one looming threat that grows from nothing
  over 1 s, in a coupled run (a jump is looming input for the other). Kind at random per duel: quickdraw
  (first escape burst wins) or stare (last wins; never jumping beats jumping). Elo K=32 from 1000. The
  worker matches 2 duels per full tick among close ratings; holders challenge with `POST /duels`. Offline
  check, 3 runs per matchup and kind: standard beats fearless (escape off) at quickdraw 3/3 and loses at
  stare 3/3; jumpy beats zen at quickdraw 3/3 (120-160 ms vs 140-180 ms), zen wins stare 3/3; sentinel
  beats standard at quickdraw 3/3, loses at stare 3/3; zen vs standard is 2-1 each way (noise decides).
- **Breeding** (`settings.breed`, `POST /breed`): parents are two of your flies, or one of yours and a
  house fly. Each value comes from one parent at random; each slider mutates with p=0.3 (sd 10% of its
  range), each dial flips to a random level with p=0.08. The child stores `parents` and `generation`.

## Flies affect each other, live patch view, missions and seasons (2026-09-13)

**Coupled patches** (`worker/patch.py`). Each patch runs as one shared brain batch. Per 20 ms step, what a
fly's brain does becomes input to its neighbours' senses on the next step, weighted by exp(-distance/0.2):
a giant-fibre escape burst (>= 3 spikes in 100 ms) drives their looming detectors (LC4, LPLC2), a burst of
walking/steering spikes drives their moving-target detectors (LC10a), and coming within 0.06 drives both
flies' face bristles. A toy body moves each fly (steering turns it, walking steps it, an escape burst hops
it once). Positions persist between ticks. Each tick the patch's event hits one random fly, or a poke
lands at a spot (full strength within 0.12, fading to nothing at 0.35); every other fly only gets what
its neighbours' brains do. Posts carry `cause` ({channel, from_fly_id, strength}) and a `threads` row
links them to the post that set them off. Ticks store a replay per patch (positions, flags, links).

Measured with 8 flies in a patch, 8 layouts, fly 0 given a threat, against the same layouts uncoupled and
coupled with no event. Pass rule fixed before each rerun: with no event, neighbours must stay near
their isolated rate (<= 5% doing anything).

| version | coupled: neighbours jumped | uncoupled | no event: any action | labels with no event |
|---|---|---|---|---|
| 1. single spikes count | 100% | 0% | 100% (runaway) | loom everywhere |
| 2. burst rule, reach 0.2 | 100% | 0% | 5% | 54/56 "heard wings" |
| 3. + sound burst rule | 98% | 0% | 7% (fail) | 55/56 "heard wings" |
| 4. no sound channel, no bump at start | 96% | 0% | 2% | 43/56 none |
| 5. + one hop per burst, start in middle 40% | **100%** | **0%** | **2%** | 46/56 none, 6 moved, 4 bumped |

Why sound was dropped: resting wing motor neurons fire in synchronous volleys (single steps up to 15-20
spikes), so 200 ms windows at rest (26-30 spikes) exceed a threatened fly's (~23). At 20 ms a neighbour's
ears can't tell rest from buzzing. Why hops changed: hopping on every escape spike carried a threatened fly
0.83 across the patch in one second, out of its neighbours' range.

**Live patch view** (web `PatchView.tsx`): a canvas map of the patch that replays its last tick 3x slower,
with jump rings, wing arcs, grooming sparkles, the event or poke marker, and lines when one fly's brain
output reaches another's senses. With a poke stimulus selected, a click on the map drops it there
(`POST /pokes` now takes x, y).

**Missions and seasons**: `my_missions()` (signed-in users only) computes daily missions (poke 3 times,
like 5 posts, make a fly react to your poke; 10 points each) and weekly ones (your flies post 30 times,
one of your flies sets off another, 10 likes from others; 50 points each) from real activity.
`season_points(since)` and the `season_board` view rank users for the current season, a 2-week round from
`season_start()` (season 1 = 7 September 2026; migration 20260913230000); the top 3 win $FLYAI; the leaderboard has Season points and a This season filter on Most popular people.

## Quick wins (2026-09-13): actions, hallucinations, pokes, faster ticks, badges, sharing

- **Actions** (`worker/actions.py`): what the fly did, read from behaviour neuron groups against standard
  flies at rest (fitted when the worker starts): jumped (escape DNs), backed up (MDN), walked forward,
  turned (DNa02, with side), groomed (DNg12), buzzed its wings (wing motor neurons). An action counts at
  >= 3 sd and >= 3 spikes above rest. Measured on 24 standard flies per stimulus: nothing -> 0% any
  action; threat -> jumped 100%, buzzed 100%; mate -> turned 100%; wind -> groomed 100%; touch ->
  groomed 100%; taste and cVA -> none. Tuned flies differ (escape off -> no jump; excitability 1.2 with
  nothing happening -> turned 86%, backed up 39%, jumped 14%).
- **Post kinds**: `sense` (read it right), `misread`, `hallucination` (read a word when nothing
  happened), `action` (no word, but it did something). `correct` is null for action posts.
- **Pokes**: `POST /pokes {patch_id, stimulus}` (holders, one per 2 minutes per user, at most 3 waiting
  per patch). The worker polls every 10 s and runs the poked patch right away; every fly there gets that
  stimulus instead of the random event, and its posts carry `poke_id`.
- **Ticks** every 2 minutes (`fly.toml`: `tick.py --every 120 --poke-poll 10`).
- **Badges** (web `badges.ts`) from `fly_board` columns: hallucinations, jumps, grooms, buzzes, pokes_felt,
  best_streak (longest run of correct reads), likes, posts.
- **Sharing**: each post has Post on X (links `flyaiworld.com/flybook/#post-<id>`, which opens that post),
  Save card image (1200x630 PNG drawn in the browser) and Copy link.
- Tested end to end 2026-09-13: poke validation (401/403/400/429), a real tick consumed the poke, all
  Windowsill flies read threat and jumped + buzzed with the poke id, a house fly hallucinated, cleanup left
  no test data. Flies whose owner holds no $FLYAI stay out of ticks (dormant), as designed.

## Likes and the most popular board

- Signed-in $FLYAI holders like posts through the API (`POST`/`DELETE /posts/<id>/like`), which checks the
  balance on chain (cached 5 minutes per wallet). Nobody can like their own fly's posts, and anyone can
  take their own like back. The `likes` table is readable by everyone and writable only by the API.
- Leaderboard: **Most popular people** ranks fly owners by likes their flies' posts get (this week and
  all time, view `owner_board`), and the flies board has **Most liked**. `owner_board` shows only a
  shortened wallet.
- For rewards, get full wallets with the service role, e.g. in the Supabase SQL editor:

  ```sql
  select pr.wallet, ob.likes_week, ob.likes, ob.flies
  from owner_board ob join profiles pr on pr.id = ob.owner_id
  order by ob.likes_week desc, ob.likes desc
  limit 10;
  ```

- Tested end to end on 2026-09-13 with throwaway wallets (balance read stubbed): no session 401,
  no $FLYAI 403, like/again/unlike counts correct, direct table writes 403, board excluded self-likes.
  One multi-wallet holder can still like from several funded wallets; each needs at least 1 $FLYAI.

## Cost (CPU, measured on the dev desktop)

One 1.5 s episode takes about 0.35 s of one core per fly (batch 1, one numba thread) and about
0.6 s per fly in a batch of 12 on 24 threads. A tick for the 12 house flies takes seconds. At
1,000 flies, run batch 1 with one process per core; see ROADMAP section 10.

## What is and isn't claimed

- A post means the translator read that word from the fly's descending neurons. The precision
  shown is measured on held-out episodes.
- A wrong post is shown as wrong ("misread"), with what really happened.
- Not yet tested: whether a scrambled-wiring brain reads just as well. Until that control runs,
  don't say the connectome's wiring is what makes a word readable.
