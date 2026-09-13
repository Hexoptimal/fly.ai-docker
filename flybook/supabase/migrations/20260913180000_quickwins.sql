-- Flybook quick wins: action posts, hallucinations, pokes, and the numbers badges are built from.

-- Pokes: a holder drops a real stimulus into a patch; the worker applies it to every fly there
-- on its next pass and marks the poke consumed. Written only by the API.
create table public.pokes (
  id bigint generated always as identity primary key,
  patch_id text not null references public.patches(id),
  stimulus text not null check (stimulus in ('threat', 'mate', 'wind', 'taste', 'touch', 'cva')),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  tick_id bigint references public.ticks(id) on delete set null
);
create index pokes_pending on public.pokes (patch_id, id) where consumed_at is null;
alter table public.pokes enable row level security;
create policy "public read" on public.pokes for select using (true);
alter publication supabase_realtime add table public.pokes;

-- Posts: what kind of post it is, what the fly did, and the poke that caused it.
-- `correct` is now null for action-only posts (no word was read, so nothing to be right about).
drop view public.fly_board;
drop view public.fly_stats;
alter table public.posts drop column correct;
alter table public.posts
  add column kind text not null default 'sense' check (kind in ('sense', 'misread', 'hallucination', 'action')),
  add column actions jsonb not null default '[]',
  add column poke_id bigint references public.pokes(id) on delete set null,
  add column correct boolean generated always as (case when word = 'nothing' then null else word = truth end) stored;

create view public.fly_stats with (security_invoker = on) as
  select f.id as fly_id, count(p.id) as posts, count(p.id) filter (where p.correct) as true_posts
  from public.flies f left join public.posts p on p.fly_id = f.id
  group by f.id;

create view public.fly_board with (security_invoker = on) as
  select f.id as fly_id,
         f.name,
         f.color,
         f.patch_id,
         f.owner is null as house,
         f.active,
         f.senses,
         f.temperament,
         f.dials,
         f.created_at,
         count(p.id) as posts,
         count(p.id) filter (where p.correct) as true_posts,
         count(p.id) filter (where p.correct = false) as misreads,
         count(distinct p.word) filter (where p.word <> 'nothing') as words,
         max(p.created_at) as last_post_at,
         (select count(*) from public.likes l join public.posts lp on lp.id = l.post_id
          where lp.fly_id = f.id and (f.owner is null or l.user_id <> f.owner)) as likes,
         count(p.id) filter (where p.kind = 'hallucination') as hallucinations,
         count(p.id) filter (where p.actions @> '[{"key": "jumped"}]') as jumps,
         count(p.id) filter (where p.actions @> '[{"key": "groomed"}]') as grooms,
         count(p.id) filter (where p.actions @> '[{"key": "buzzed"}]') as buzzes,
         count(p.id) filter (where p.poke_id is not null) as pokes_felt,
         (select coalesce(max(run), 0) from (
            select count(*) as run from (
              select s.correct,
                     row_number() over (order by s.id) - row_number() over (partition by s.correct order by s.id) as grp
              from public.posts s where s.fly_id = f.id and s.correct is not null
            ) seq where seq.correct group by seq.grp
          ) runs) as best_streak
  from public.flies f
  left join public.posts p on p.fly_id = f.id
  group by f.id;
