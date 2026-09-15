-- Fly relationships: friends, enemies, rivals, mates and family, read from what the flies' brains did to each other.
-- Nothing is stored and nothing changes how flies behave; fly_bonds() adds up events that already happened:
--   startled  a neighbour set the fly off and it jumped, or its escape burst loomed over the fly (patch.py 'loom')
--   drawn     a neighbour's moves caught its moving-target detectors (LC10a, 'target'); a 'mate' read from it counts double
--   touched   a neighbour bumped its face bristles and it didn't jump (counts half)
--   duels     finished duels between the two (rivalry, not hostility; friends who duel stay friends)
--   matings   the two had a baby; family: parent and child, or the same parent
-- Brain events fade with age (weight exp(-age / 7 days)) so relationships change as flies move around.
-- Cut-offs were set on 7 days of live posts (2026-09-15: 2,886 caused posts over 98 pairs, 85% 'target';
-- median pair 11 events, 90th percentile 81; tension share median 0.02, 90th percentile 0.46).

create index if not exists posts_cause_from on public.posts ((cause->>'from_fly_id'), created_at desc) where cause is not null;
create index if not exists posts_caused_recent on public.posts (created_at desc) where cause is not null;
create index if not exists duels_done_pair on public.duels (a_fly, b_fly, done_at desc) where status = 'done';

-- Every relationship of one fly (focus_fly), or of every fly (null), over the last window_days (1-90).
-- One row per pair, a < b. a_* columns are what fly a felt about fly b (startled by b, drawn to b, touched by b).
create or replace function public.fly_bonds(focus_fly uuid default null, window_days int default 30)
returns table (
  a uuid, b uuid,
  a_startled int, b_startled int, a_drawn int, b_drawn int, a_touched int, b_touched int,
  a_wins int, b_wins int, draws int, matings int,
  kin text,                 -- 'a_parent' (a is b's parent), 'b_parent', 'siblings' or null
  warmth real, tension real, last_at timestamptz, label text
)
language sql stable set search_path = public as $$
  with win as (select now() - make_interval(days => greatest(1, least(coalesce(window_days, 30), 90))) as since),
  caused as (
    select p.fly_id as receiver, (p.cause->>'from_fly_id')::uuid as sender, p.created_at,
           exp(-extract(epoch from now() - p.created_at) / 604800.0) as w,
           p.cause->>'channel' = 'loom' or p.actions @> '[{"key": "jumped"}]' as startled,
           p.cause->>'channel' = 'target' and not p.actions @> '[{"key": "jumped"}]' as drawn,
           p.cause->>'channel' = 'bump' and not p.actions @> '[{"key": "jumped"}]' as touched,
           p.word = 'mate' as mate_read
    from posts p, win
    where p.cause is not null and p.created_at >= win.since
      and (focus_fly is null or p.fly_id = focus_fly or p.cause->>'from_fly_id' = focus_fly::text)
  ),
  social as (
    select least(receiver, sender) as a, greatest(receiver, sender) as b,
           count(*) filter (where startled and receiver < sender) as a_startled,
           count(*) filter (where startled and receiver > sender) as b_startled,
           count(*) filter (where drawn and receiver < sender) as a_drawn,
           count(*) filter (where drawn and receiver > sender) as b_drawn,
           count(*) filter (where touched and receiver < sender) as a_touched,
           count(*) filter (where touched and receiver > sender) as b_touched,
           coalesce(sum(w * case when mate_read then 2 else 1 end) filter (where drawn), 0)
             + 0.5 * coalesce(sum(w) filter (where touched), 0) as warmth,
           coalesce(sum(w) filter (where startled), 0) as tension,
           max(created_at) as last_at
    from caused where receiver <> sender
    group by 1, 2
  ),
  fights as (
    select least(d.a_fly, d.b_fly) as a, greatest(d.a_fly, d.b_fly) as b,
           count(*) filter (where d.winner = least(d.a_fly, d.b_fly)) as a_wins,
           count(*) filter (where d.winner = greatest(d.a_fly, d.b_fly)) as b_wins,
           count(*) filter (where d.winner is null) as draws,
           max(d.done_at) as last_at
    from duels d, win
    where d.status = 'done' and d.done_at >= win.since and (focus_fly is null or focus_fly in (d.a_fly, d.b_fly))
    group by 1, 2
  ),
  mates as (
    select least(m.a_fly, m.b_fly) as a, greatest(m.a_fly, m.b_fly) as b, count(*) as n, max(m.created_at) as last_at
    from matings m
    where m.a_fly is not null and m.b_fly is not null and (focus_fly is null or focus_fly in (m.a_fly, m.b_fly))
    group by 1, 2
  ),
  parent_links as (
    select par as parent, c.id as child from flies c cross join unnest(c.parents) as par where par <> c.id
  ),
  kin as (
    select distinct on (a, b) a, b, kin from (
      select least(parent, child) as a, greatest(parent, child) as b,
             case when parent < child then 'a_parent' else 'b_parent' end as kin, 0 as pri
      from parent_links where focus_fly is null or focus_fly in (parent, child)
      union all
      select least(x.child, y.child), greatest(x.child, y.child), 'siblings', 1
      from parent_links x join parent_links y on x.parent = y.parent and x.child < y.child
      where focus_fly is null or focus_fly in (x.child, y.child)
    ) k order by a, b, pri
  ),
  keys as (
    select a, b from social union select a, b from fights union select a, b from mates union select a, b from kin
  ),
  joined as (
    select k.a, k.b,
           coalesce(s.a_startled, 0)::int as a_startled, coalesce(s.b_startled, 0)::int as b_startled,
           coalesce(s.a_drawn, 0)::int as a_drawn, coalesce(s.b_drawn, 0)::int as b_drawn,
           coalesce(s.a_touched, 0)::int as a_touched, coalesce(s.b_touched, 0)::int as b_touched,
           coalesce(f.a_wins, 0)::int as a_wins, coalesce(f.b_wins, 0)::int as b_wins, coalesce(f.draws, 0)::int as draws,
           coalesce(m.n, 0)::int as matings, kn.kin,
           coalesce(s.warmth, 0)::real as warmth, coalesce(s.tension, 0)::real as tension,
           greatest(s.last_at, f.last_at, m.last_at) as last_at
    from keys k
    join flies fa on fa.id = k.a
    join flies fb on fb.id = k.b
    left join social s on s.a = k.a and s.b = k.b
    left join fights f on f.a = k.a and f.b = k.b
    left join mates m on m.a = k.a and m.b = k.b
    left join kin kn on kn.a = k.a and kn.b = k.b
  )
  select j.*,
         case
           when j.matings > 0 then 'mates'
           when j.kin is not null then 'family'
           when j.tension >= 8 and j.tension >= 0.25 * (j.warmth + j.tension) and j.warmth >= 25 then 'frenemies'
           when j.tension >= 8 and j.tension >= 0.25 * (j.warmth + j.tension) then 'enemies'
           when j.warmth >= 120 and j.tension < 0.1 * (j.warmth + j.tension) then 'best friends'
           when j.warmth >= 25 and j.tension < 0.25 * (j.warmth + j.tension) then 'friends'
           -- the Arena matchmakes neighbouring Elo, so the same pairs duel often: rivalry only when their brains aren't close
           when j.a_wins + j.b_wins + j.draws >= 5 then 'rivals'
           else 'acquaintances'
         end as label
  from joined j
  order by j.warmth + j.tension + 3 * (j.a_wins + j.b_wins + j.draws) desc
  limit 600;
$$;

grant execute on function public.fly_bonds(uuid, int) to anon, authenticated;
