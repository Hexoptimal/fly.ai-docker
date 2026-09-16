-- The always-on simulation (world/server/run.ts): one continuous world, recorded.
-- Same database as Flybook, separate tables, all prefixed world_. Rows are jsonb because the simulation's columns
-- change as it grows (world/src/datalog.ts is the schema); t is simulated seconds since the run began.
-- Writes come from the server with the service role; everything except checkpoints is public to read.

create table public.world_runs (
  id uuid primary key default gen_random_uuid(),
  seed integer not null,
  started_at timestamptz not null default now(),
  git_sha text,
  config jsonb not null default '{}'::jsonb
);

-- one row every WORLD_EVERY_S simulated seconds: population, brood, groups, aggregation, brain change, memory, relationships
create table public.world_seconds (
  id bigserial primary key,
  run_id uuid not null references public.world_runs(id) on delete cascade,
  t double precision not null,
  at timestamptz not null default now(),
  row jsonb not null
);
create index world_seconds_run_t on public.world_seconds (run_id, t);

-- one row per fly every FLY_EVERY_S: position, state, meals, firing rates, brain change, memory, group
create table public.world_fly_samples (
  id bigserial primary key,
  run_id uuid not null references public.world_runs(id) on delete cascade,
  t double precision not null,
  fly_id integer not null,
  at timestamptz not null default now(),
  row jsonb not null
);
create index world_fly_samples_run_t on public.world_fly_samples (run_id, t);
create index world_fly_samples_run_fly on public.world_fly_samples (run_id, fly_id, t);

-- every mating, egg, hatch, meal, spider strike, death, dropping and arrival
create table public.world_events (
  id bigserial primary key,
  run_id uuid not null references public.world_runs(id) on delete cascade,
  t double precision not null,
  kind text not null,
  at timestamptz not null default now(),
  row jsonb not null
);
create index world_events_run_t on public.world_events (run_id, t);
create index world_events_run_kind on public.world_events (run_id, kind, t);

-- one row per fly ever: sex, generation, parents, genes; on death the cause, age, meals, brain change, offspring
create table public.world_lineage (
  run_id uuid not null references public.world_runs(id) on delete cascade,
  fly_id integer not null,
  updated_at timestamptz not null default now(),
  row jsonb not null,
  primary key (run_id, fly_id)
);

-- one row per egg: parents, substrate, and what became of it
create table public.world_eggs (
  run_id uuid not null references public.world_runs(id) on delete cascade,
  egg_id integer not null,
  updated_at timestamptz not null default now(),
  row jsonb not null,
  primary key (run_id, egg_id)
);

-- one row per pair of flies that ever met: time together, bumps, startles, courtship, matings, family, label
create table public.world_relationships (
  run_id uuid not null references public.world_runs(id) on delete cascade,
  a integer not null,
  b integer not null,
  label text,
  updated_at timestamptz not null default now(),
  row jsonb not null,
  primary key (run_id, a, b)
);

-- the whole world, gzipped, so a restart or deploy carries on where it stopped. Server only; the last few are kept.
create table public.world_checkpoints (
  id bigserial primary key,
  run_id uuid not null references public.world_runs(id) on delete cascade,
  t double precision not null,
  bytes integer not null,
  created_at timestamptz not null default now(),
  data text not null
);
create index world_checkpoints_run_created on public.world_checkpoints (run_id, created_at desc);

alter table public.world_runs enable row level security;
alter table public.world_seconds enable row level security;
alter table public.world_fly_samples enable row level security;
alter table public.world_events enable row level security;
alter table public.world_lineage enable row level security;
alter table public.world_eggs enable row level security;
alter table public.world_relationships enable row level security;
alter table public.world_checkpoints enable row level security;
create policy "public read" on public.world_runs for select using (true);
create policy "public read" on public.world_seconds for select using (true);
create policy "public read" on public.world_fly_samples for select using (true);
create policy "public read" on public.world_events for select using (true);
create policy "public read" on public.world_lineage for select using (true);
create policy "public read" on public.world_eggs for select using (true);
create policy "public read" on public.world_relationships for select using (true);
-- no policy on world_checkpoints: only the service role reads or writes it
