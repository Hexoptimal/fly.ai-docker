-- Fly-made coins (2026-09-15): flies launch their own SIMULATED coins in the fly market, shill them, FUD their enemies'
-- coins, buy back and dump (worker/launches.py). Fake coins, fake ETH. Written only by the worker.

-- a fly coin is a small liquidity pool the creator seeded; its price moves with every buy and sell
alter table public.market_coins drop constraint if exists market_coins_kind_check;
alter table public.market_coins add constraint market_coins_kind_check check (kind in ('real', 'meme', 'fly'));
alter table public.market_coins
  add column creator uuid references public.flies(id) on delete set null,
  add column persona text,                                  -- degen, jumpy, chill, watcher, normie
  add column tagline text,
  add column image_path text,                               -- object path in the coins bucket
  add column image_model text,
  add column image_cost real,                               -- USD reported by OpenRouter
  add column launched_at timestamptz,
  add column launch_price double precision,
  add column supply double precision,
  add column pool_eth double precision,
  add column pool_tokens double precision,
  add column status text not null default 'live' check (status in ('live', 'dead'));
create index market_coins_by_creator on public.market_coins (creator) where creator is not null;

alter table public.fly_trades drop constraint if exists fly_trades_side_check;
alter table public.fly_trades add constraint fly_trades_side_check
  check (side in ('buy', 'panic_sell', 'take_profit', 'sell', 'skipped', 'launch', 'buyback', 'dump'));

-- each fly's launch itch and the coins it made: {urge, coins, rounds, last_round}
alter table public.fly_minds add column launch jsonb not null default '{}';

-- launches, shills, FUD, buybacks and dumps; next round they reach other flies' senses through their relationships
create table public.market_social (
  id bigint generated always as identity primary key,
  round_id bigint references public.market_rounds(id) on delete cascade,
  fly_id uuid references public.flies(id) on delete cascade,
  kind text not null check (kind in ('launch', 'shill', 'fud', 'buyback', 'dump')),
  symbol text not null,
  reach int not null default 0,                             -- flies with a bond that would feel it
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index market_social_recent on public.market_social (id desc);
create index market_social_launches on public.market_social (created_at) where kind = 'launch';
alter table public.market_social enable row level security;
create policy "public read" on public.market_social for select using (true);
alter publication supabase_realtime add table public.market_social;

create view public.fly_coin_board with (security_invoker = on) as
  select c.symbol, c.name, c.tagline, c.persona, c.image_path, c.price, c.launch_price, c.supply, c.pool_eth, c.status,
         c.launched_at, c.creator, f.name as creator_name, f.color as creator_color, f.owner as creator_owner,
         c.price * c.supply as market_cap,
         c.price / nullif(c.launch_price, 0) - 1 as since_launch,
         (select count(*) from public.fly_portfolios p where coalesce((p.holdings -> c.symbol ->> 'qty')::float8, 0) > 0) as holders
  from public.market_coins c
  left join public.flies f on f.id = c.creator
  where c.kind = 'fly';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('coins', 'coins', true, 1000000, array['image/webp'])
on conflict (id) do nothing;
