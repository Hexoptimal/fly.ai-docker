-- Flybook leaderboard: one row per fly with its post counts. Read with the anon key like the feed.
-- No wallet addresses: profiles stay private.

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
         count(p.id) filter (where not p.correct) as misreads,
         count(distinct p.word) as words,
         max(p.created_at) as last_post_at
  from public.flies f
  left join public.posts p on p.fly_id = f.id
  group by f.id;
