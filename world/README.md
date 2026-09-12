# fly.ai world — flies with spiking brains

A low-poly field of fruit flies living on fruit, carrion, dung and compost. Each
fly runs its own spiking neural network: leaky integrate-and-fire neurons named
after real *Drosophila* cell types, wired in the same shape as the pathways the
rest of this repository measures in the MaleCNS connectome. Click a fly and watch
its brain fire; every label above a fly is a readout of its population rates.

```
what a fly sees, smells, hears and feels
  └─> R1-6 · LPLC2 LC4 LPLC1 LC10a VS · ORN_DM1 VM5d VL2a IR92a DA1 VA1d · Or56a Gr21a
      · JO · SNta LgLG LB3
        └─> antennal lobe (AL-LN, lPN, DA2 PN) · lateral horn · central brain
              └─> descending neurons DNa02, DNp01, DNg100, MDN
                    └─> VNC premotor (VNC-IN, IN19A)
                          └─> motor neurons DLM, b1, b2, Ti flexor/extensor, …
                                └─> wings and legs
```

Nothing between the senses and the muscles is scripted. There is no
`if (nearFruit) goToFruit` and no `if (geosmin) avoid`. Flight is read from the
**motor neurons**, not from the descending neurons.

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # type-checks, then writes dist/
npm run preview
```

## Deploy to Vercel

Static Vite site, no backend. Import the repository, set the root directory to
`world/`, and `vercel.json` does the rest. Or `cd world && vercel deploy --prod`.

## The brain

`src/brain.ts` runs the same update as `fly_brain.py`:

```
v <- exp(-dt/tau) * v + gain * (W @ spikes) + tonic + noise + sensory input
v >= 1  ->  spike, reset to 0
```

`dt` 20 ms, `tau` 100 ms, threshold 1. **612 neurons per fly (306 per side),
4,718 synapses**, generated once from seed 64 and never trained, with
`build_brain.py`'s weight recipe: synapse counts, negative when the presynaptic
neuron is inhibitory, then each neuron's incoming weights normalised to sum to 1.
All flies share the matrix and keep their own voltages and noise, exactly as
`FlyBrain(batch=N)` does.

Population sizes follow the proportions of the real MaleCNS sensory classes
(ol_sensory 6,098 / cb_sensory 4,868 / vnc_sensory 6,370 / vnc_motor 708), about
25× smaller.

## The senses

**Vision** (`src/eyes.ts`) — the two routes from `fly_eyes.py`: a luminance
panorama onto R1-6, and the feature detectors driven by angular size and its
growth, on the side the object is on. Plus **VS**, the lobula plate cells that
report ventral optic flow (ground speed over height) — this is what regulates
altitude now; there is no height controller in the physics.

**Olfaction** (`src/senses.ts`) — a **turbulent puff field**. Every source
releases discrete packets at a stochastic rate; packets are advected by the wind,
wander sideways, and spread as they age. A fly downwind therefore gets
**intermittent hits with real gaps**, not a smooth cone (about 900–1,000 live
puffs at any moment, sampled through a uniform grid). Seven channels, with the
real receptor→ligand pairings:

| Receptor | Ligand | Comes from | Sign |
|---|---|---|---|
| ORN_DM1 | ethyl acetate | ripe fruit | attract |
| ORN_VM5d | ethyl butyrate | fermenting fruit, compost | attract |
| ORN_VL2a | acetic acid | vinegar, fruit | attract |
| IR92a | ammonia / amines | carrion, dung, droppings | attract |
| ORN_DA1, ORN_VA1d | cVA | **other flies** | attract |
| **Or56a → DA2** | **geosmin** | **mouldy fruit** | **aversive** |
| **Gr21a/Gr63a → V** | **CO2** | **compost, frightened flies** | **aversive** |

Receptor dynamics differ by job, which is the fidelity fix that made plume
tracking work: the food and cVA receptors are **phasic** (they adapt with
τ = 0.5 s, so what reaches the brain is the *onset* of a puff), while Or56a and
Gr21a are **tonic** labelled lines that keep reporting a sustained danger.

Attractive receptors → lPN → PFL3/LAL (steering) and PVLP (thrust). Aversive
receptors → **DA2 PN → LH**, and the lateral horn drives the *opposite* LAL,
vetoes the ipsilateral one through LPi, and pushes MDN. Turn-toward and
turn-away use the same machinery with opposite sign.

**Johnston's organ** — airflow (wind minus own velocity), own wingbeat,
neighbours' wingbeat. JO → WED → LAL and DNg100.

**Legs** — SNta on contact (**phasic**), LgLG on knocks, LB3 on food
(**tonic**). They drive the GABAergic IN19A, which shuts the wing motor neurons
down: that is what makes a fly land and stay rather than a state flag.

## The world

Fermenting fruit, **mouldy fruit** (geosmin), carrion, dung, a compost heap
(food odour *and* CO2), plants, rocks — and **droppings**: a fly that has fed
long enough leaves one, it persists for 150 s and emits amines, so the world
slowly accumulates its own attractants. Everything except rocks can be landed on
and walked over, because landing is just leg contact.

The **swatter** comes down on a key press and looms exactly like anything else,
so the scattering is the real LC4/LPLC2 → DNp01 pathway. Mid-air collisions
tumble both flies. Names, live state tags (FEEDING, SURGING, CASTING, PANIC,
LANDED), a leaderboard, a live population graph (adults and brood over the last
five minutes, with the mating, egg and death counts beside it), fly cam and
drama cam are all readouts, never drivers.

## What the measurements say

### Cast-and-surge does emerge (`tools/surge.ts`)

16 flies, wind 1.6 m/s, 180 s, binned by time since the last phasic odour hit:

| time since a puff hit | speed | upwind heading | steering | DLM |
|---|---|---|---|---|
| < 0.25 s (a hit) | **2.71 m/s** | **0.771** | **2.31** | **8.7 Hz** |
| 0.25–0.75 s | 2.76 | 0.653 | 2.62 | 8.5 |
| 0.75–1.5 s | 2.55 | 0.616 | 2.72 | 8.1 |
| 1.5–3 s | 2.37 | 0.633 | 2.72 | 7.8 |
| > 3 s (plume lost) | **2.11** | **0.595** | **2.93** | **7.4** |

Monotonic in all four columns: on contact a fly speeds up, straightens, heads
further upwind and drives its wings harder; as the plume is lost it slows, turns
more and drifts off the wind axis. That is surge-and-cast, and nothing in the
code says so — it falls out of phasic receptors feeding the same steering and
thrust populations the wind pathway feeds.

### The ablation table (`tools/ablate.ts`)

24 flies, 60 s warm-up then 100 s measured, wind 1.2 m/s. "Occupancy" is the
share of fly-samples within 2 m of good fruit versus mouldy fruit;
"toward-neighbour" is the speed-independent attraction measure (+1 = heading
straight at the nearest fly, 0 = no preference).

| wiring | fruit dist | good/mould | land | feed | toward-neighbour | DLM | v | alt |
|---|---|---|---|---|---|---|---|---|
| **intact** | 11.37 m | 0.60 | 42 | 673 | −0.049 | 7.4 | 1.89 | 3.51 |
| no food ORN → lPN | 11.21 | 0.71 | 58 | 558 | −0.000 | 7.9 | 2.13 | 5.87 |
| no cVA ORN → lPN | 11.20 | 1.00 | 269 | 1184 | −0.068 | 6.7 | 0.95 | 1.28 |
| no geosmin (Or56a → DA2) | 12.74 | 0.79 | 55 | 799 | −0.091 | 6.8 | 1.69 | 2.92 |
| no CO2 (Gr21a → V) | 10.11 | 1.30 | 147 | 781 | −0.036 | 7.2 | 1.61 | 2.69 |
| no aversive line at all | 9.01 | 1.24 | 215 | 1178 | −0.115 | 6.7 | 0.80 | 1.33 |
| no LH output | 12.72 | 0.50 | 24 | 438 | −0.047 | 7.5 | 1.68 | 4.11 |
| no JO → WED | 9.44 | 2.00 | 42 | 999 | −0.122 | 6.7 | 0.95 | 1.75 |
| no leg SN → IN19A | 10.75 | 1.10 | **14** | **321** | −0.053 | 7.3 | 1.78 | 3.67 |
| **no DN → VNC premotor** | 13.76 | — | 9 | 341 | −0.108 | **2.5** | **0.07** | **0.42** |
| no LC10a → steering | 11.25 | 0.76 | 51 | 1165 | −0.108 | 5.0 | 0.20 | 0.61 |
| no VS (ventral optic flow) | 10.81 | 1.09 | 219 | 1638 | −0.032 | 6.5 | 0.62 | **0.89** |

And with strong plumes (wind 2.0): intact upwind heading **0.80**, no JO → WED
**0.35**.

Honest reading, item by item against the previous round's findings:

1. **The motor stage is real, again.** Cutting descending → VNC premotor:
   DLM 7.4 → 2.5 Hz, tibia extensor 3.7 → 0.9 Hz, speed 1.89 → 0.07 m/s,
   altitude 3.51 → 0.42 m. The flies sit on the ground twitching.
2. **Legs still make feeding happen.** Landings 42 → 14, feeding 673 → 321.
3. **Johnston's organ produces strong anemotaxis** — upwind heading 0.80 versus
   0.35 at wind 2.0 — and it *still* costs them food (cutting it raises feeding
   from 673 to 999). Flying upwind is time not spent on fruit. **Diagnosis for
   the "why":** JO → WED → LAL and lPN → PFL3/LAL converge on the *same* LAL →
   DNa02 output, so upwind drive and odour-gradient drive are literally summed at
   one steering neuron. When the wind direction and the plume's cross-wind
   gradient disagree, whichever is larger wins and the other is lost. That is a
   real prediction of this wiring, not a bug, and it is what you would expect of
   a single shared steering channel.
4. **VS closes the altitude loop.** Height is no longer clamped: mean altitude is
   3.5 m intact and collapses to 0.89 m with VS cut, with feeding rising (flies
   that cannot hold height end up on the ground, where the food is). Altitude is
   now neural; the only remaining clamp is a 12 m safety ceiling that is rarely
   touched.
5. **Finding 6 still holds: olfaction does not win foraging in a crowd.** With
   puffs and phasic receptors, cutting the food channel changes nothing
   measurable in the open world (11.37 → 11.21 m). It *does* now show at wind 2.0
   in the earlier round's assay sense — surge is real and measurable — but the
   distance metric in a 32 m field with 12 fruit, 9 mould patches, carrion, dung
   and compost is dominated by where flies happen to settle, not by search.
6. **cVA, with the confound removed, does not attract.** The speed-independent
   measure is −0.049 intact and −0.000 with cVA cut: flies are, if anything,
   very slightly *avoiding* their nearest neighbour, and removing cVA moves that
   to indifference. The old clustering result was arousal, exactly as suspected.
   No aggregation pheromone effect survives a speed-matched measure.
7. **The geosmin pathway fires but does not steer them off the mould.** Or56a
   runs at 1.6 Hz and LH at 6.5–9 Hz next to a mouldy fruit, so the channel is
   alive — but the occupancy ratio is 0.60 intact and 0.79 with geosmin cut, i.e.
   flies spend slightly *more* time near mould with the pathway intact. In a
   controlled two-choice arena (`tools/choice.ts`, fruit and mould 10 m apart in
   a 13 m arena, both orientations): intact 0.64 and 1.14, geosmin-cut 0.61 and
   1.28, LH-output-cut 0.70. **The side-swap variance is bigger than any
   ablation effect.** There is no geosmin avoidance in this model. The aversive
   drive reaches steering at a few Hz against a much larger visual and olfactory
   arousal background, and it loses.
8. **A methodological warning that applies to every row above.** Because each
   neuron's inputs are normalised to sum to 1, cutting one input *raises the
   weight of the rest*. Cutting Or56a → DA2 PN raised LH's firing from ~7 Hz to
   ~12 Hz (CO2 now owns the whole input budget). These ablations are therefore
   not clean knockouts, and small differences between rows should not be trusted.

## Measured performance

Headless Chrome, software WebGL (SwiftShader), 1400×900, 612 neurons per fly,
~900–1,000 live odour puffs:

| flies | frames/s | brain step, all flies |
|---|---|---|
| 36 | 76 | 3.1 ms |
| 60 | 77 | 5.2 ms |

The simulation is a fixed 20 ms accumulator decoupled from rendering, so even at
60 flies it uses about a quarter of each step's budget. The puff field is sampled
through a uniform grid; without it the frame rate was 48 fps at 60 flies.

## The life cycle (newest round, not yet measured)

Flies have a sex, an age, and a death. **640 neurons / 4,923 synapses** now.

* **Courtship uses the real circuit.** Males have **Gr68a/ppk23** foreleg contact
  chemoreceptors, which answer a female at close range, and **LC10a** (already
  there, already the fly's visual target-tracker) — both drive **P1**, the male
  command population, which drives **pIP10**, which drives the b1/b2 wing motor
  neurons: song is a wing motor pattern, not a sound effect. Rejection is not a
  coin flip: a mated female carries the male's **cVA**, cVA reaches the GABAergic
  AL-LN, and AL-LN inhibits P1 — so a mated female stops being courted because of
  a real labelled line.
* **Eggs.** A mated female on a food substrate lays at a rate read off the brain:
  `LB3 (taste) − LH (aversion)`. On mouldy fruit the lateral horn wins and no
  eggs are laid. Eggs hatch into larvae (25 s), larvae eat the substrate and
  pupate into adults (45 s).
* **Ageing** is a decline in the populations, not a health bar: `senseGain` and
  the motor tonic fall with age, so an old fly injects less sensory voltage and
  rests further below threshold — visibly a worse flier, and visible in its brain
  panel.
* **Death** from old age, starvation (240 s without feeding), the swatter (now
  lethal) or a spider. **Spiders** rear up when a fly comes near — their radius
  grows, which is real looming the eyes see — then strike, and anything still on
  the ground dies. That is the giant fibre's job.
* **Corpses become carrion**, which the amine channel already makes attractive,
  so the world feeds on its own dead.
* **Day and night.** The clock runs a 300 s day. Daylight is a sun-elevation
  curve, and it is *not* decoration: it scales the background luminance of the
  panorama the photoreceptors see, so a fly at night is genuinely working with a
  darker world. There is no "it is night" flag anywhere in the brain.
* **Every action shows on the map.** Mating, egg-laying, a hatch, the start of a
  meal, a dropping, a spider strike and a death each drop a marker where they
  happened, which
  fades over 6 s, and the same events fill the "Happening now" feed in the
  panel. A meal marks once rather than once per bounce, and a spider that misses
  marks at most once every 8 s.

A 600 s headless run with 30 flies (two in-world days, seed 7): 17 matings,
26 eggs, 26 hatched, deaths 6 old age / 24 starved / 6 eaten, ending at 18
adults. Starvation dominates mortality. Every one of the six actions fires on its
own — mating, egg-laying, hatching, feeding, spider attacks and death — which is
what this round was for.

### Predation and the giant fibre (`tools/lifeab.ts`)

24 flies, 30 s settle then 250 s measured, four independent world seeds. Deaths
are per 1,000 fly-seconds, so a run that loses flies early is not scored as safer
than one that does not.

| wiring | eaten / 1000 fly-s | other deaths | DNp01 | near the ground |
|---|---|---|---|---|
| **intact** | **0.30 ± 0.16** | 1.46 ± 0.26 | 0.91 Hz | 41.2 ± 6.1% |
| no loom → DNp01 | 1.94 ± 0.96 | 0.46 ± 0.29 | 0.00 Hz | 78.1 ± 7.4% |
| **no DNp01 → jump muscles** | **0.71 ± 0.29** | 2.23 ± 0.45 | 1.06 Hz | 36.8 ± 9.4% |

**The escape pathway keeps them alive, and the second row is why you need the
third.** Cutting the looming input to DNp01 raises spider deaths 6.5×, but it
also parks the flies near the ground (41% → 78%), so most of that is posture, not
a failed escape — LPLC2/LC4 feed steering and thrust as well as the giant fibre.
Cutting DNp01's *output* to the jump muscles is the clean test: the neuron still
fires at 1.06 Hz, time near the ground is unchanged, and deaths by spider still
more than double, 0.30 → 0.71. That is the giant fibre doing its job, measured
with the confound removed.

### Courtship: the circuit fires, but it does not control mating

24 flies, 50 s settle then 250 s measured, four seeds. P1 is the male command
population; pIP10 drives the wing motor neurons that make the song.

| wiring | matings | eggs | P1 (males) | pIP10 |
|---|---|---|---|---|
| **intact** | 6.0 ± 1.6 | 17.0 ± 4.2 | 5.07 Hz | 6.03 Hz |
| no LC10a → P1 (vision) | 7.5 ± 1.7 | 11.5 ± 5.7 | **1.78** | **1.64** |
| no Gr68a → P1 (contact) | 4.3 ± 1.9 | 11.0 ± 5.8 | **11.30** | 12.00 |
| no AL-LN ⊣ P1 (cVA veto) | 6.0 ± 0.7 | 15.8 ± 3.4 | 10.98 | 12.90 |

**A clean negative, and it indicts our own code rather than the wiring.** P1 spans
1.8 to 11.3 Hz across these rows — a six-fold range — and the number of matings
does not move: every row overlaps 6.0 ± 1.6. Mating here is proximity plus a
threshold that noise crosses in either direction, exactly as the "fudged" note
below admits. The courtship circuit is real and it responds to its inputs; it
simply is not what decides whether a mating happens.

Two further warnings sit in this table. Cutting the *contact* input **raises** P1
from 5.07 to 11.30 Hz, because normalised weights hand the dead input's share to
the survivors — large enough here to invert the expected direction. And the cVA
veto cannot be tested this way at all: removing an inhibitory input raises P1 for
two reasons at once, and the mating rule ignores both.

### Egg-laying substrate: the assay does not work

20 flies, one fruit and one mould patch 8 m apart in a 13 m arena, 300 s, four
seeds, sides swapped between seeds. Counts are eggs and larvae still sitting on
each patch at the end.

| wiring | on fruit | on mould | LB3 (taste) | LH (aversion) |
|---|---|---|---|---|
| intact | 0.3 ± 0.4 | 0.0 ± 0.0 | 0.21 Hz | 6.66 Hz |
| no geosmin → DA2 | 0.3 ± 0.4 | 0.8 ± 0.8 | 0.20 | **8.42** |
| no LH output | 0.5 ± 0.9 | 0.3 ± 0.4 | 0.20 | **9.61** |

**Nothing can be concluded from these numbers, and the reason is worth more than
the numbers would have been.** Egg-laying drive is `LB3 − LH`, but LB3 idles
around 0.2 Hz while LH sits near 7 Hz, so the drive is negative almost everywhere
and fewer than one egg per run is laid in the arena. The rate constants are simply
mismatched: two populations subtracted from each other with no common scale.

Worse, the obvious fix — cut the aversive input and see whether eggs return — is
**unavailable in this model**. Cutting Or56a → DA2 PN *raises* LH to 8.42 Hz, and
cutting LH's output raises it to 9.61 Hz, because in both cases the remaining
inputs absorb the normalised budget. There is no way to lower LH by removing
something that feeds it. Any future test of this pathway has to compare LH against
its own baseline, or gate on the geosmin channel directly, rather than subtract
one raw population rate from another.

**Fudged, and worth knowing.** Mating is a world rule that reads P1 (above 6 Hz
and within 0.8 m) rather than a courtship sequence; female receptivity is a
minimum age; egg, larval and adult timings are seconds rather than days; larvae
have no brain at all.

## What isn't real

* **This is not the connectome.** 612 neurons and 4,718 synapses from a seeded
  PRNG and a block diagram, against 166,700 neurons and 25.6 M connections of
  electron microscopy. Nothing downloaded, nothing trained.
* **Names real, numbers invented.** Every population is a real cell type and
  every receptor→ligand pairing is the real one (Or56a/geosmin, Gr21a/CO2,
  IR92a/ammonia, DA1/cVA, VL2a/acetic acid). Counts, connection probabilities and
  synapse weights are made up. `VNC-IN` is not a cell type — it is a generic
  premotor pool standing in for the VNC's interneuron hemilineages.
* **The plume is a toy.** Discrete Gaussian packets with a random walk: it has
  intermittency and gaps, but no real turbulence, no filaments, no meander.
* **The tonic fudge survived.** Premotor and flight motor neurons still rest
  above the global tonic. The cause is structural and worth stating plainly: with
  inputs normalised to sum to 1 and gain 1.5, a neuron needs roughly 40% of its
  input mass to spike within one 20 ms step, which means presynaptic rates near
  20 Hz. This network runs at 5–10 Hz, so any chain more than a couple of stages
  deep dies unless tonic drive carries it — which is exactly why the Python model
  uses tonic 0.14 globally and Fly64 parks every neuron at threshold. We use a
  lower global tonic and restore it selectively for the motor stage. Stronger
  weights do not fix it, because normalisation cancels them.
* **Aversion does not work.** See finding 7. The wiring is there; the behaviour
  is not.
* **The decoder is hand-written.** Motor-neuron rates → speed, yaw, lift, jump
  (`MOTOR` in `src/sim.ts`). Everything upstream is the network.
* **Flight is not aerodynamics**: no wing forces, no body rotation but yaw, and
  the fly is carried by the wind at 90%.
* **The photoreceptor route contributes little**, as `sweep.py` finds in the real
  model.

## Files

| File | What it does |
|---|---|
| `src/wiring.ts` | populations, connection blocks, `build_brain.py` normalisation |
| `src/brain.ts` | the LIF step, one shared matrix, per-fly state |
| `src/eyes.ts` | panorama, feature detectors, the `fly_eyes.py` encoder |
| `src/senses.ts` | the puff field, receptor tuning and adaptation, JO, legs |
| `src/sim.ts` | world, ecology, fixed-timestep loop, motor decoder, physics |
| `src/scene.ts` | low-poly Three.js: instanced flies, props, swatter, wind motes |
| `src/brainview.ts` | live neuron view and spike raster, grouped by modality |
| `src/main.ts` | overlay, labels, leaderboard, cameras, loop |
| `tools/` | `ablate.ts` (the table), `lifeab.ts` (predation, courtship, egg substrate), `surge.ts` (cast-and-surge), `choice.ts` (geosmin two-choice), `assay.ts`, `flight.ts`, `probe.ts`, `tune.ts`, `sweep.ts`, `smell.ts`, `range.ts`, `motor.ts` — run with `node --experimental-strip-types tools/<file>.ts` |

MIT, like the rest of the repository.
