-- Flybook: flies affect each other (positions, causes, replays), click-to-poke, missions and seasons.

-- Where each fly is in its patch (a 1 x 1 square) and which way it faces. The worker moves them.
alter table public.flies
  add column x real,
  add column y real,
  add column heading real;

-- A poke can land at a spot on the patch map.
alter table public.pokes
  add column x real check (x between 0 and 1),
  add column y real check (y between 0 and 1);

-- What a neighbour did to the fly, when that is what really happened: {channel, from_fly_id, strength}.
alter table public.posts add column cause jsonb;

-- One replay per patch the tick ran: {patch_id: {flies, frames, links, event}}.
alter table public.ticks add column replay jsonb;

-- Most popular people: add this season (the current calendar month, UTC).
create or replace view public.owner_board as
  select pr.id as owner_id,
         left(pr.wallet, 6) || '…' || right(pr.wallet, 4) as wallet_short,
         (select count(*) from public.flies f where f.owner = pr.id) as flies,
         (select coalesce(json_agg(json_build_object('name', f.name, 'color', f.color) order by f.created_at), '[]')
          from public.flies f where f.owner = pr.id) as fly_list,
         (select count(*) from public.posts p join public.flies f on f.id = p.fly_id where f.owner = pr.id) as posts,
         (select count(*) from public.likes l join public.posts p on p.id = l.post_id join public.flies f on f.id = p.fly_id
          where f.owner = pr.id and l.user_id <> pr.id) as likes,
         (select count(*) from public.likes l join public.posts p on p.id = l.post_id join public.flies f on f.id = p.fly_id
          where f.owner = pr.id and l.user_id <> pr.id and l.created_at > now() - interval '7 days') as likes_week,
         (select count(*) from public.likes l join public.posts p on p.id = l.post_id join public.flies f on f.id = p.fly_id
          where f.owner = pr.id and l.user_id <> pr.id and l.created_at >= date_trunc('month', now())) as likes_season
  from public.profiles pr
  where exists (select 1 from public.flies f where f.owner = pr.id);

-- Missions. Daily missions reset at 00:00 UTC, weekly on Monday 00:00 UTC. Daily = 10 points, weekly = 50.
-- Progress is computed from what people and their flies actually did; nothing is stored separately.
create or replace function public.my_missions()
returns table (key text, period text, label text, progress bigint, target int, points int)
language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as uid),
       day as (select date_trunc('day', now()) as d),
       wk as (select date_trunc('week', now()) as w)
  select 'poke3', 'daily', 'Poke a patch 3 times',
         (select count(*) from pokes, me, day where pokes.user_id = me.uid and pokes.created_at >= day.d), 3, 10
  union all
  select 'like5', 'daily', 'Like 5 posts',
         (select count(*) from likes, me, day where likes.user_id = me.uid and likes.created_at >= day.d), 5, 10
  union all
  select 'stir', 'daily', 'Make a fly react to your poke',
         (select count(distinct p.id) from pokes pk join posts p on p.poke_id = pk.id, me, day
          where pk.user_id = me.uid and pk.created_at >= day.d), 1, 10
  union all
  select 'chatty', 'weekly', 'Your flies post 30 times',
         (select count(*) from posts p join flies f on f.id = p.fly_id, me, wk where f.owner = me.uid and p.created_at >= wk.w), 30, 50
  union all
  select 'chain', 'weekly', 'One of your flies sets off another fly',
         (select count(*) from threads t join posts pp on pp.id = t.parent_post join flies f on f.id = pp.fly_id
          join posts c on c.id = t.child_post, me, wk where f.owner = me.uid and c.created_at >= wk.w), 1, 50
  union all
  select 'loved', 'weekly', 'Get 10 likes from other holders',
         (select count(*) from likes l join posts p on p.id = l.post_id join flies f on f.id = p.fly_id, me, wk
          where f.owner = me.uid and l.user_id <> me.uid and l.created_at >= wk.w), 10, 50;
$$;
revoke execute on function public.my_missions() from anon;
grant execute on function public.my_missions() to authenticated;

-- Season points per user since `since`: every completed daily mission (per day) and weekly mission (per week).
create or replace function public.season_points(since timestamptz)
returns table (user_id uuid, points bigint, missions bigint)
language sql stable security definer set search_path = public as $$
  with
  poke_days as (select pk.user_id, date_trunc('day', pk.created_at) as d, count(*) as n
                from pokes pk where pk.created_at >= since group by 1, 2),
  like_days as (select l.user_id, date_trunc('day', l.created_at) as d, count(*) as n
                from likes l where l.created_at >= since group by 1, 2),
  stir_days as (select pk.user_id, date_trunc('day', pk.created_at) as d, count(distinct p.id) as n
                from pokes pk join posts p on p.poke_id = pk.id where pk.created_at >= since group by 1, 2),
  post_weeks as (select f.owner as user_id, date_trunc('week', p.created_at) as w, count(*) as n
                 from posts p join flies f on f.id = p.fly_id where f.owner is not null and p.created_at >= since group by 1, 2),
  chain_weeks as (select f.owner as user_id, date_trunc('week', c.created_at) as w, count(*) as n
                  from threads t join posts pp on pp.id = t.parent_post join flies f on f.id = pp.fly_id
                  join posts c on c.id = t.child_post where f.owner is not null and c.created_at >= since group by 1, 2),
  liked_weeks as (select f.owner as user_id, date_trunc('week', l.created_at) as w, count(*) as n
                  from likes l join posts p on p.id = l.post_id join flies f on f.id = p.fly_id
                  where f.owner is not null and l.user_id <> f.owner and l.created_at >= since group by 1, 2),
  done as (
    select user_id, 10 as pts from poke_days where n >= 3
    union all select user_id, 10 from like_days where n >= 5
    union all select user_id, 10 from stir_days where n >= 1
    union all select user_id, 50 from post_weeks where n >= 30
    union all select user_id, 50 from chain_weeks where n >= 1
    union all select user_id, 50 from liked_weeks where n >= 10
  )
  select user_id, sum(pts)::bigint, count(*)::bigint from done group by user_id;
$$;

-- Season leaderboard (this calendar month), shortened wallets only.
create view public.season_board as
  select sp.user_id, left(pr.wallet, 6) || '…' || right(pr.wallet, 4) as wallet_short, sp.points, sp.missions
  from public.season_points(date_trunc('month', now())) sp
  join public.profiles pr on pr.id = sp.user_id;
