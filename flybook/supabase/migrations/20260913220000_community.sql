-- Flybook community: owner captions, comments, duels + Elo, breeding lineage, weekly challenges.

-- Comments: holders comment on posts. Written only by the API (it checks the balance and rate).
create table public.comments (
  id bigint generated always as identity primary key,
  post_id bigint not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  wallet_short text not null,
  body text not null check (char_length(body) between 1 and 280),
  created_at timestamptz not null default now()
);
create index comments_by_post on public.comments (post_id, id);
alter table public.comments enable row level security;
create policy "public read" on public.comments for select using (true);
alter publication supabase_realtime add table public.comments;

-- Captions are now written by the API too (owner + holder check), not directly by clients.
drop policy "owner captions" on public.captions;
alter publication supabase_realtime add table public.captions;

-- Elo record and lineage on flies.
alter table public.flies
  add column elo int not null default 1000,
  add column duels int not null default 0,
  add column wins int not null default 0,
  add column losses int not null default 0,
  add column draws int not null default 0,
  add column parents uuid[] not null default '{}',
  add column generation int not null default 1;

-- Duels: two flies, one slowly growing looming threat. quickdraw = first to jump wins, stare = last to jump wins.
create table public.duels (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('quickdraw', 'stare')),
  a_fly uuid not null references public.flies(id) on delete cascade,
  b_fly uuid not null references public.flies(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,     -- null: matched by the worker
  status text not null default 'pending' check (status in ('pending', 'done', 'cancelled')),
  winner uuid references public.flies(id) on delete set null,         -- null when done = draw
  a_step int,                                                         -- first escape burst, ms into the threat
  b_step int,
  a_elo int,                                                          -- ratings before the duel
  b_elo int,
  delta int,                                                          -- Elo points moved from b to a (negative: a to b)
  replay jsonb,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  check (a_fly <> b_fly)
);
create index duels_pending on public.duels (id) where status = 'pending';
create index duels_done on public.duels (done_at desc) where status = 'done';
alter table public.duels enable row level security;
create policy "public read" on public.duels for select using (true);
alter publication supabase_realtime add table public.duels;

-- Weekly challenge standings for the week starting `week_start` (a Monday, UTC). The theme rotates:
-- calm (fewest jumps when a threat really happened, 3+ threats), alarm (set off the most flies),
-- sharp (share of reads right, 10+ reads), loved (likes from other holders).
create or replace function public.challenge_board(week_start timestamptz)
returns table (challenge text, fly_id uuid, name text, color text, house boolean, owner_wallet text, score real, detail text)
language sql stable security definer set search_path = public as $$
  with c as (
    select (array['calm', 'alarm', 'sharp', 'loved'])[1 + (floor(extract(epoch from week_start) / 604800)::bigint % 4)::int] as key
  ),
  wk as (select week_start as s, week_start + interval '7 days' as e),
  calm as (
    select p.fly_id, count(*) as n, count(*) filter (where p.actions @> '[{"key": "jumped"}]') as j
    from posts p, wk where p.truth = 'threat' and p.created_at >= wk.s and p.created_at < wk.e group by p.fly_id
  ),
  alarm as (
    select pp.fly_id, count(*) as n
    from threads t join posts pp on pp.id = t.parent_post join posts ch on ch.id = t.child_post, wk
    where ch.created_at >= wk.s and ch.created_at < wk.e group by pp.fly_id
  ),
  sharp as (
    select p.fly_id, count(*) filter (where p.correct) as t, count(*) filter (where p.correct is not null) as n
    from posts p, wk where p.created_at >= wk.s and p.created_at < wk.e group by p.fly_id
  ),
  loved as (
    select p.fly_id, count(*) as n
    from likes l join posts p on p.id = l.post_id join flies f on f.id = p.fly_id, wk
    where l.created_at >= wk.s and l.created_at < wk.e and (f.owner is null or l.user_id <> f.owner) group by p.fly_id
  ),
  rows as (
    select c.key, f.id, f.name, f.color, f.owner is null as house,
           (select left(pr.wallet, 6) || '…' || right(pr.wallet, 4) from profiles pr where pr.id = f.owner) as owner_wallet,
           case c.key
             when 'calm' then 1 - calm.j::real / nullif(calm.n, 0)
             when 'alarm' then alarm.n::real
             when 'sharp' then sharp.t::real / nullif(sharp.n, 0)
             else loved.n::real
           end as score,
           case c.key
             when 'calm' then format('held still through %s of %s threats', calm.n - calm.j, calm.n)
             when 'alarm' then format('set off %s flies', alarm.n)
             when 'sharp' then format('%s of %s reads right', sharp.t, sharp.n)
             else format('%s likes', loved.n)
           end as detail,
           case c.key
             when 'calm' then coalesce(calm.n, 0) >= 3
             when 'alarm' then coalesce(alarm.n, 0) >= 1
             when 'sharp' then coalesce(sharp.n, 0) >= 10
             else coalesce(loved.n, 0) >= 1
           end as qualifies,
           coalesce(calm.n, alarm.n, sharp.n, loved.n, 0) as volume
    from c cross join flies f
    left join calm on calm.fly_id = f.id
    left join alarm on alarm.fly_id = f.id
    left join sharp on sharp.fly_id = f.id
    left join loved on loved.fly_id = f.id
  )
  select key, id, name, color, house, owner_wallet, score, detail
  from rows where qualifies
  order by score desc, volume desc, name
  limit 50;
$$;
