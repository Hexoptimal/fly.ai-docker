# FLYBRAIN: the fly.ai brain plays SSH Fighter

https://github.com/user-attachments/assets/7c3b91e5-9b50-4017-a03a-123aedd4d7b4

*Video not playing? [Open `video.mp4` directly](video.mp4).*

The [fly.ai](../README.md) connectome (166,700 neurons, 25.6 million connections) plays
[SSH Fighter](https://sshfighter.com), an online terminal fighting game, as a registered bot
called FLYBRAIN.

The game only touches the network at a few neuron types known from the literature to detect
things and to issue movement commands. Everything in between is the connectome.

It loses most matches, though it has now won one. It chases its opponent, and the reason it chases turns
out to be real fly biology.

![Dashboard: the fight on the left, every neuron of the fly's nervous system on the right](media/dashboard.png)

## How it works

```
game state (30 Hz)
  └─> "eyes": opponent + projectiles as objects on the fly's left / right
        └─> LPLC2 (looming)  LC4 (threat)  LPLC1 (projectiles)  LC10a (the target a male chases)
              └─> 166,700-neuron connectome, leaky integrate-and-fire, 50 steps/s
                    └─> descending neurons (the brain's commands to the body)
                          └─> buttons: move, jump, punch, kick
```

| Readout neuron | What it does in a real fly | What it does in the game |
|---|---|---|
| DNa02, left vs right | steering while walking | walk left / right |
| DNp01 (giant fiber) | escape take-off from looming objects | jump |
| DNg100 | forward walking (as in Fly64) | walk forward |
| MDN ("moonwalker") | backward walking | back off (= block) |
| DNg11 | nothing to do with fighting (arbitrary choice) | punch |
| pIP10 | courtship song | kick |

* **Eyes** (`../fly_eyes.py`): the game state drives four of the fly's own visual neuron types,
  on the side where things are:

  | Neuron type | Driven by |
  |---|---|
  | LPLC2 (looming) | the opponent getting bigger as it approaches |
  | LC4 (fast looming / escape) | the opponent attacking, more strongly when close |
  | LPLC1 (small approaching objects) | projectiles |
  | LC10a (chase) | where the opponent is, more strongly when close |

  Each type was checked by stimulation to reach the descending neurons (see the core
  [README](../README.md#what-we-found)).
* **Decoder** (`fly_fighter.py`): counts spikes of the readout neurons in short windows. These
  thresholds are hand-picked, and they are the only hand-tuned part between the brain and the
  buttons.
* **Dashboard** (`fly_dashboard.py`, `dashboard.html`): shows the live match next to all
  140,638 neurons that have a measured position. Each dot flashes when its neuron fires.

## What we found in the game

1. **In a closed loop, it chases.** Against a scripted dummy for 90 s, **64%** of its moves went
   toward the opponent, where chance is 50%. This is the LC10a → DNa02 courtship-pursuit pathway.
2. **It doesn't dodge.** 22% of its jumps happened while a projectile was nearby, against 20% by
   chance. It jumps when the opponent rushes in, not at shots.
3. **Eight flies voting chase harder.** With `--flies 8` the GPU runs 8 copies of the brain (same
   wiring, each with its own noise). Each copy decides with the same rule, and the majority wins.
   Against the dummy (90 s, 4 noise seeds each):

   | | Moves toward the opponent | Punches | Kicks | Jumps near a shot |
   |---|---|---|---|---|
   | 1 fly | 61–66% (mean 63%) | 197–203 | 49–69 | 17–32% (chance 16–22%) |
   | 8 flies voting | **70–74% (mean 72%)** | 71–89 | 0–1 | 9–21% (chance 14–16%) |

   Voting filters out noise. The chase signal is shared by all copies, so it gets stronger, while
   the random punches and kicks, which were never driven by the game, mostly disappear. Dodging
   stays at chance.

   Averaging the flies' spike counts instead of voting fails badly: 97% of moves go away from
   the opponent. The backward-walking neuron MDN fires about 1 spike/s at rest and forward almost
   never, so the average is backward almost all the time.
4. **Live record:** 0 wins, 6 losses against other bots when this was written. It dealt 311
   damage, took 1,200 and landed 40 hits. Punches and kicks come only from background noise.
   Current record: [sshfighter.com/players/FLYBRAIN](https://sshfighter.com/players/FLYBRAIN).
5. **The fly was reacting two frames late, and fixing that produced the first win.** Eight
   voting copies cost 59-70 ms of brain time per frame, against a 30 Hz game that gives you
   33 ms. Dropping to `--flies 2` puts the step at 16-27 ms, inside the budget. Nothing else
   changed - same trained readout, same encoder, same steering:

   | | brain time / frame | result |
   |---|---|---|
   | 8 flies voting | 59-70 ms (over budget) | 0 wins, opponent finished around 86 HP |
   | 2 flies voting | 16-27 ms | **first win**, and 1-7 over the run |

   The win was against ajax-tissue, 100-67 and 61-15 over two rounds:
   [sshfighter.com/matches/mmtyehkmd5947](https://sshfighter.com/matches/mmtyehkmd5947).
   Every live measurement taken before this was made under the latency handicap, so the earlier
   "the trained readout doesn't help live" results are worth re-reading: the offline gains were
   real, they just could not get through a loop running at half the game's frame rate.
6. **A trained movement readout learns to back away, and that is correct.** Trained on
   `damage dealt - damage taken` over the next second it always picks "away" (-16.1, against
   -18.3 for "toward"), because the fly deals little damage, so the objective reduces to
   minimising damage taken. Against opponents that close the distance this is fine; against a
   passive opponent nobody advances, rounds time out at 100-100 and the match never ends. Use
   `--no-move-readout` and let the brain's own DNa02 steer.

## Trained readout (reservoir computing)

Everything above is untrained. As a next step, the brain stays frozen and only **linear layers
reading its 1,314 descending neurons** (the brain's output cables to the body) are trained. This
technique is called reservoir computing. Nothing inside the brain changes.

* **Labels come from the fly's own experience.** While recording, it presses punch and kick at
  random and holds a random move (away, still or toward) for half of its 1-second movement
  decisions.
  * Each press is labelled by whether the game reported that it connected (`attackConnected`).
  * Each random move is scored by damage dealt minus damage taken over the next second.
* **Model:** descending-neuron spike traces (τ = 100 ms) are compressed to their top principal
  components (5, 20 or 60, chosen on held-out data). A regularised linear model is fitted on
  top: logistic regression for attacks, and ridge regression of the HP swing for each move.
* **Evaluation:** leave-one-match-out, so every sample is judged by a model that never saw its
  match. Each readout is compared against a baseline that sees the game state directly
  (distance, and whether the opponent is attacking). The melee ranges are punch 30 and kick 42,
  from the game engine, as used in [alextitonis/ai-model](https://github.com/alextitonis/ai-model).
  `reservoir.py` implements all of this.

**Round 1** (8 matches, attacks only, before the threat and projectile channels existed): punch
AUC 0.63 vs 0.71 for distance alone, kick 0.65 vs 0.84. Live, the readout landed 4.9 hits/min
against 3.9 for random presses. That's within chance at 4 matches (p ≈ 0.2).

**Round 2** (20 matches, four input channels, movement exploration):

| Readout | Samples | Fly readout (held-out) | Game-state baseline | Chance |
|---|---|---|---|---|
| Punch: will it connect? | 407 presses, 41 connected | **AUC 0.77** | 0.83 | 0.50 |
| Kick: will it connect? | 205 presses, 28 connected | AUC 0.67 | 0.88 | 0.50 |

* **Punch.** At the chosen threshold the readout presses on 9% of chances, and **19% of those
  connect**, against 10% for random presses. The simple reach rule is better still: it presses
  on 8% of chances and 50% of those connect. The neurons it relies on most are **DNp04, DNp01
  and DNp02, the escape neurons**, which the looming and threat inputs drive. It learned to
  treat the fly's "something big is right on top of me" signal as a cue to punch.
* **Kick.** Presses it chooses connect no more often than random ones, so it isn't used in play.
* **Movement.** Over 909 random one-second holds, the average HP swing was −3.9 for backing away
  (which blocks), −5.1 for standing still and −5.0 for moving toward the opponent. Neither the
  fly readout nor the game-state rule found a situation where another move does better, so the
  movement readout learned to always back away. Against these bots, turtling is the best of the
  three options.

While exploring it went 0–20: 17 damage dealt per minute and 2.0 hits per minute.

**Always backing away produces endless stalemates.** With the movement readout in control, the
first live match reached round 11 with every round a 100–100 draw. The fly backed away and the
opponent stayed back too, so the round timer ran out each time and the match never ended. That
policy avoids damage but can never win, so the live test below keeps the fly's own untrained
steering (chasing) and uses the trained readout for punches only (`--no-move-readout`).

**Live result: no improvement.**

| Attacks and movement | Matches | Damage dealt / min | Damage taken / min | Hits / min | Wins |
|---|---|---|---|---|---|
| random attacks, random moves half the time (exploration) | 20 | 17 | 182 | 2.0 | 0 |
| trained punch readout + the fly's own steering | 6 | 13 | 294 | 2.0 | 0 |

The trained punches landed at the same rate as random ones, and chasing into the opponent took
damage faster. The readout's offline edge (19% of chosen punches connecting, against 10% at
random) didn't carry over to live play. The bottleneck looks like the interface, meaning what
the brain is told and how its output becomes actions, not yet the wiring.

### Encoder search (replays of 20 new matches)

The next step, following the "interface first" principle, is to improve what the brain is told
while the brain stays frozen. We recorded 20 new matches with 8 voting flies. They went 0–20
against nine different bots, with random punches and kicks as usual while recording. We then
replayed them through fresh brains with different encoders (`replay.py`). Each encoder is
scored by the held-out AUC of a punch readout: will this press connect? The data is 329 presses,
51 of which connected.

| Encoder | Punch AUC (held-out) |
|---|---|
| distance only (game-state baseline) | **0.867** |
| hand-set, 8 noise draws | 0.685 ± 0.028 (0.640 to 0.728) |
| hand-set, 8 flies averaged | 0.698 |
| no looming channel | **0.555** |
| threat ×2 | 0.602 |
| no chase / no threat / no shot / shot ×2 / all ×1.5 | 0.643 to 0.692, within noise |

* **Looming carries the punch signal.** Without the looming input (LPLC2), the readout barely
  beats chance.
* **The fly doesn't see distance well.** The baseline that knows the distance is far ahead. In
  the hand-set encoder, the chase signal is squeezed into a narrow range and looming fires only
  while the opponent approaches. So the next round gives the fly distance through its own
  neurons: looming neurons that also respond to the opponent's size, a steeper chase signal,
  and a higher cap (`fly_eyes.ENCODER`, `--encoder`).
* **Second sweep: looming by size.** Real looming neurons respond to how big an object is, not
  only to how fast it grows. Adding that (`loom_size`) lifts the punch readout step by step:

  | Encoder (second sweep) | Punch AUC (held-out) |
  |---|---|
  | hand-set | 0.698 |
  | `loom_size=0.3` | 0.735 |
  | **`loom_size=0.6`** | **0.789** |
  | steeper chase, higher cap, looming ×2 | 0.689 to 0.733, within noise or near it |

  At 0.789, `loom_size=0.6` is about 3.7 noise standard deviations above the hand-set encoder.
  It still trails the distance baseline (0.867). The side effect shows up in the fly's own
  behaviour. Against the dummy (90 s, same noise seed), it still chases as much (64% toward
  the opponent), but it jumps 2.5 times as often (86 jumps against 35). Looming neurons drive the
  escape neuron DNp01, so a big opponent close by now triggers escape jumps.
* **Third sweep: how far to push it.** `loom_size=0.6` holds up with fresh noise: three runs
  gave 0.789, 0.806 and 0.780. The readout plateaus around 0.80 from 0.6 to 1.2 (0.9 scored
  0.805, or 0.810 with cap 1.2; 1.2 scored 0.798), then collapses at 1.8 (0.62). An input that
  strong swamps the neurons. `loom_size=0.6` is the pick: the smallest setting that reaches the
  plateau, and the only one tested three times.
* **Next:** a live test of `--encoder loom_size=0.6` against the hand-set encoder, both with 8
  voting flies.
* **Dodging can't be measured yet.** These bots mostly fight up close. Only 12 of the moments in
  these matches had a shot approaching, and a held-out score needs at least 30.

### Limitations

* The game buttons and decoder thresholds were chosen by hand. Flies can't punch.
* See also the core [limitations](../README.md#limitations).

## Run it

First set up the core and build the brain (see the [main README](../README.md#run-it)). Then,
from this folder:

```sh
cd sshfighter
python fly_fighter.py --offline --seconds 120 --dashboard     # fake opponent, opens http://127.0.0.1:8777
```

Add `--device cuda` to run the brain on an NVIDIA GPU (see the [main README](../README.md#run-it)).
It brings brain time down to about 2.6 ms per game frame, against about 15 ms on the CPU.
Add `--flies 8` for eight voting copies. On an RTX 4060 laptop GPU that runs at about 40 frames
per second, just above the game's 30. Live, brain time was 24–34 ms per frame, which leaves
little room.

`--encoder name=value,...` changes what the fly is told, for example `--encoder loom_size=0.6`.
The parameters are listed in `fly_eyes.ENCODER`; any you don't set keep the hand-set value.
`--seed` sets the brain's noise seed.

**Playing online.** Give the bot its own SSH key and name:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/sshfighter-mybot -N ''
ssh -i ~/.ssh/sshfighter-mybot -o IdentitiesOnly=yes MYBOT@sshfighter.com   # press Enter, type the name, Enter, quit
python fly_fighter.py --user MYBOT --identity ~/.ssh/sshfighter-mybot --opponents bots --matches 3 --dashboard
```

The server labels bots automatically. Please keep `--opponents bots` unless people actually want
to fight a fly.

**Train the readout:**

```sh
python fly_fighter.py --user MYBOT --identity ~/.ssh/sshfighter-mybot --opponents bots --matches 8 --record recordings
python reservoir.py train recordings          # held-out report, writes readout.npz
python fly_fighter.py --user MYBOT --identity ~/.ssh/sshfighter-mybot --opponents bots --matches 4 --readout readout.npz

# watch a finished match again, driven through the brain, with the dashboard
python fly_fighter.py --replay logs/20260912-160803-mmtyehkmd5947.jsonl --dashboard --speed 0.5
python fly_fighter.py --replay recordings5/<mid>.states.jsonl.gz --dashboard
```

Match logs are written to `sshfighter/logs/`.

**Replay matches with a different encoder.** With `--record`, every game state is also saved to
`<match>.states.jsonl.gz`, and jumps become random: rarely at other times, more often when an
enemy shot is close. Those random jumps are the labels for a dodge readout. `replay.py` runs
recorded matches back through fresh brains, open-loop. The fly's actions stay what they were,
but the brain can be told the game differently. Each fly in a batch gets its own encoder, so
8 encoders cost about one replay on the GPU:

```sh
python replay.py encoders recordings3    # punch and dodge readouts for 8 encoder variants, held-out
python replay.py dodge recordings3       # dodge readout from 8 voting flies vs always/never jumping
```

Replays are cached in `<folder>/replay/`.

## Files

| File | What it does |
|---|---|
| `fly_fighter.py` | game loop, decoder, offline dummy, SSH Fighter bot protocol |
| `fly_dashboard.py`, `dashboard.html` | live dashboard (Server-Sent Events, no extra dependencies) |
| `reservoir.py` | records descending-neuron activity and game states, and trains and applies the linear punch/kick/move readout |
| `replay.py` | replays recorded matches through fresh brains to compare encoders and train a dodge readout |
| `media/`, `video.mp4` | screenshots and the demo video |

## Credits

* **[SSH Fighter](https://sshfighter.com)** by Thomas Davis
  ([source](https://github.com/thomasdavis/sshfighter.com)), including its bot API. SSH Fighter is
  a separate project and is not part of this repository.
* Connectome and model credits are in the [main README](../README.md#credits).
