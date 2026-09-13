-- Seasons become 2-week rounds (the $FLYAI reward cadence). Season 1 starts Monday 2026-09-07 00:00 UTC;
-- each season is 14 days, so every season holds two whole mission weeks (weeks start Monday UTC).
-- Every 2 weeks the top 3 on the season board win $FLYAI rewards.

create or replace function public.season_start(at timestamptz default now())
returns timestamptz
language sql immutable as $$
  select timestamptz '2026-09-07 00:00:00+00'
         + floor(extract(epoch from (at - timestamptz '2026-09-07 00:00:00+00')) / 1209600) * interval '14 days';
$$;

create or replace view public.season_board as
  select sp.user_id, left(pr.wallet, 6) || '…' || right(pr.wallet, 4) as wallet_short, sp.points, sp.missions
  from public.season_points(public.season_start()) sp
  join public.profiles pr on pr.id = sp.user_id;

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
          where f.owner = pr.id and l.user_id <> pr.id and l.created_at >= public.season_start()) as likes_season
  from public.profiles pr
  where exists (select 1 from public.flies f where f.owner = pr.id);
