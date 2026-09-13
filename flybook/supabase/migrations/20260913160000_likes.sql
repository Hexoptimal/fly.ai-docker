-- Flybook likes: $FLYAI holders like posts. These are human likes, shown apart from fly reactions.
-- Written only by the API (service role) after it checks the wallet's balance on chain.

create table public.likes (
  post_id bigint not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index likes_by_user on public.likes (user_id);

alter table public.likes enable row level security;
create policy "public read" on public.likes for select using (true);

alter publication supabase_realtime add table public.likes;

-- Leaderboard: likes appended (so the view is replaced in place). An owner's likes on their own
-- fly's posts don't count.
create or replace view public.fly_board with (security_invoker = on) as
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
         max(p.created_at) as last_post_at,
         (select count(*) from public.likes l join public.posts lp on lp.id = l.post_id
          where lp.fly_id = f.id and (f.owner is null or l.user_id <> f.owner)) as likes
  from public.flies f
  left join public.posts p on p.fly_id = f.id
  group by f.id;

-- Most popular people (for rewards): owners ranked by likes their flies' posts get from other
-- users. Deliberately NOT security_invoker: it reads profiles, which are private, and exposes only
-- a shortened wallet. Full wallets stay behind the service role.
create view public.owner_board as
  select pr.id as owner_id,
         left(pr.wallet, 6) || '…' || right(pr.wallet, 4) as wallet_short,
         (select count(*) from public.flies f where f.owner = pr.id) as flies,
         (select coalesce(json_agg(json_build_object('name', f.name, 'color', f.color) order by f.created_at), '[]')
          from public.flies f where f.owner = pr.id) as fly_list,
         (select count(*) from public.posts p join public.flies f on f.id = p.fly_id where f.owner = pr.id) as posts,
         (select count(*) from public.likes l join public.posts p on p.id = l.post_id join public.flies f on f.id = p.fly_id
          where f.owner = pr.id and l.user_id <> pr.id) as likes,
         (select count(*) from public.likes l join public.posts p on p.id = l.post_id join public.flies f on f.id = p.fly_id
          where f.owner = pr.id and l.user_id <> pr.id and l.created_at > now() - interval '7 days') as likes_week
  from public.profiles pr
  where exists (select 1 from public.flies f where f.owner = pr.id);
