-- Fly merch, round 2 (2026-09-18):
--  claims  every shop order of fly merch gets a thank-you card (sent by Fourthwall to the buyer) with a one-use code
--          for a free fly: a "gift" fly that, like a fly born from mating, doesn't count toward the owner's cap and
--          stays active on a free account. Written by the merch worker and the API only.
--  awards  on the 1st of each month the fly whose merch sold the most items last month is Fly of the month: it's
--          featured in the shop and the app, gets a badge, and its owner gets MERCH_AWARD_POINTS season points.

alter table public.flies add column gift boolean not null default false;   -- hatched from a merch thank-you code

create table public.merch_claims (
  code text primary key,
  order_id text not null unique,                   -- one code per shop order
  design_id bigint references public.merch_designs(id) on delete set null,
  fly_id uuid references public.flies(id) on delete set null,     -- the fly on the merch (for the welcome)
  card_sent_at timestamptz,                        -- the thank-you card reached Fourthwall
  claimed_by uuid references auth.users(id) on delete set null,
  claimed_fly uuid references public.flies(id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index merch_claims_unsent on public.merch_claims (created_at) where card_sent_at is null;
alter table public.merch_claims enable row level security;

create table public.merch_awards (
  month date primary key,                          -- first day of the month the sales were in
  design_id bigint not null references public.merch_designs(id) on delete cascade,
  fly_id uuid not null references public.flies(id) on delete cascade,
  owner uuid references auth.users(id) on delete set null,
  sold int not null,
  points int not null,
  created_at timestamptz not null default now()
);
alter table public.merch_awards enable row level security;
create policy "public read" on public.merch_awards for select using (true);

-- items sold per live design this calendar month (UTC), not counting cancelled orders
create view public.merch_month as
  select d.id, d.fly_id, d.preview_path, coalesce(sum(s.quantity), 0)::int as sold
  from public.merch_designs d
  join public.merch_sales s on s.design_id = d.id
    and s.status <> 'CANCELLED' and s.ordered_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
  where d.status = 'live'
  group by d.id;
grant select on public.merch_month to anon, authenticated;

-- season points: the missions (20260914120000_free_accounts.sql) plus Fly of the month for the winner's owner
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
                  where f.owner is not null and l.by_holder and l.user_id <> f.owner and l.created_at >= since group by 1, 2),
  done as (
    select user_id, 10 as pts from poke_days where n >= 3
    union all select user_id, 10 from like_days where n >= 5
    union all select user_id, 10 from stir_days where n >= 1
    union all select user_id, 50 from post_weeks where n >= 30
    union all select user_id, 50 from chain_weeks where n >= 1
    union all select user_id, 50 from liked_weeks where n >= 10
    union all select owner, points from merch_awards where owner is not null and created_at >= since
  )
  select user_id, sum(pts)::bigint, count(*)::bigint from done group by user_id;
$$;
