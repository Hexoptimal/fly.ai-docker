-- Flybook, phase 1: house flies post into patches; everyone can read.
-- Only the worker (service role, which bypasses RLS) writes flies, ticks, posts and reactions.

create table public.patches (
  id text primary key,
  name text not null,
  blurb text not null default '',
  event_mix jsonb not null,               -- word -> weight, drawn once per fly per tick
  created_at timestamptz not null default now()
);

create table public.profiles (             -- phase 2: one row per wallet sign-in
  id uuid primary key references auth.users on delete cascade,
  wallet text unique,
  created_at timestamptz not null default now()
);

create table public.flies (
  id uuid primary key default gen_random_uuid(),
  owner uuid references public.profiles(id) on delete set null,   -- null = house fly
  name text not null unique check (char_length(name) between 1 and 40),
  color text not null default '#e0342c',
  patch_id text not null references public.patches(id),
  senses jsonb not null default '{}',
  temperament jsonb not null default '{}',
  dials jsonb not null default '{}',
  wiring_variant text not null default 'male-cns-v1.0',
  seed int not null default 0,
  created_at timestamptz not null default now()
);

create table public.ticks (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  git_sha text,
  config jsonb not null,                   -- episode, brain step, min precision, seed
  translator jsonb not null,               -- version, held-out precision/recall, postable words
  flies int not null default 0,
  posts int not null default 0,
  seconds real
);

create table public.posts (
  id bigint generated always as identity primary key,
  tick_id bigint not null references public.ticks(id) on delete cascade,
  fly_id uuid not null references public.flies(id) on delete cascade,
  patch_id text not null references public.patches(id),
  word text not null,                      -- what the translator read from the fly's DNs
  confidence real not null,                -- that word's held-out precision
  truth text not null,                     -- what really happened to the fly
  correct boolean generated always as (word = truth) stored,
  wing_hz real,
  neurons jsonb not null default '[]',     -- [{type, z}] vs the resting brain
  created_at timestamptz not null default now()
);
create index posts_recent on public.posts (id desc);
create index posts_by_fly on public.posts (fly_id, id desc);
create index posts_by_patch on public.posts (patch_id, id desc);

create table public.reactions (            -- phase 3: another fly's DN response
  id bigint generated always as identity primary key,
  post_id bigint not null references public.posts(id) on delete cascade,
  fly_id uuid not null references public.flies(id) on delete cascade,
  kind text not null check (kind in ('buzz', 'alarm')),
  z jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.threads (              -- phase 3: a post that caused another
  parent_post bigint not null references public.posts(id) on delete cascade,
  child_post bigint not null references public.posts(id) on delete cascade,
  cause text not null,
  primary key (parent_post, child_post)
);

create table public.captions (             -- phase 2: the owner's words, always shown as human
  post_id bigint primary key references public.posts(id) on delete cascade,
  author uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 280),
  created_at timestamptz not null default now()
);

create view public.fly_stats with (security_invoker = on) as
  select f.id as fly_id, count(p.id) as posts, count(p.id) filter (where p.correct) as true_posts
  from public.flies f left join public.posts p on p.fly_id = f.id
  group by f.id;

alter table public.patches enable row level security;
alter table public.profiles enable row level security;
alter table public.flies enable row level security;
alter table public.ticks enable row level security;
alter table public.posts enable row level security;
alter table public.reactions enable row level security;
alter table public.threads enable row level security;
alter table public.captions enable row level security;

create policy "public read" on public.patches for select using (true);
create policy "public read" on public.flies for select using (true);
create policy "public read" on public.ticks for select using (true);
create policy "public read" on public.posts for select using (true);
create policy "public read" on public.reactions for select using (true);
create policy "public read" on public.threads for select using (true);
create policy "public read" on public.captions for select using (true);
create policy "own profile" on public.profiles for select using (id = auth.uid());

-- a caption can only be written by the owner of the fly that made the post
create policy "owner captions" on public.captions for insert to authenticated with check (
  author = auth.uid() and exists (
    select 1 from public.posts p join public.flies f on f.id = p.fly_id
    where p.id = post_id and f.owner = auth.uid()));

alter publication supabase_realtime add table public.posts, public.ticks;
