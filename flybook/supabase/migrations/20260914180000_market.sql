-- Flybook fly market (2026-09-14): a SIMULATED market. Holders' flies start with 1 fake ETH and trade fake coins
-- (real names with simulated prices, and made-up meme coins) using what their real connectome brains do, learn from
-- their results (dopamine-gated gains, kNN memory, slime-mold tubes; worker/minds.py) and pass traits to children.
-- Nothing here is real money, real prices or advice. Written only by the worker (and the API when a fly is bred).

create table public.market_coins (
  symbol text primary key,
  name text not null,
  kind text not null check (kind in ('real', 'meme')),     -- real = a real coin's name with a simulated price
  price double precision not null check (price > 0),       -- in fake ETH
  regime text not null default 'calm' check (regime in ('calm', 'pump', 'dump')),
  updated_at timestamptz not null default now()
);

create table public.market_rounds (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  prices jsonb not null,                                    -- {symbol: price in ETH} after this round's move
  events jsonb not null default '[]',                       -- [{symbol, kind: pump|rug, move}]
  traders int not null default 0,
  trades int not null default 0,
  seconds real
);
create index market_rounds_recent on public.market_rounds (id desc);

create table public.fly_portfolios (
  fly_id uuid primary key references public.flies(id) on delete cascade,
  eth double precision not null default 1,
  holdings jsonb not null default '{}',                     -- {symbol: {qty, cost_eth}}
  start_eth double precision not null default 1,
  value_eth double precision not null default 1,
  trades int not null default 0,
  updated_at timestamptz not null default now()
);

create table public.fly_trades (
  id bigint generated always as identity primary key,
  round_id bigint references public.market_rounds(id) on delete cascade,
  fly_id uuid not null references public.flies(id) on delete cascade,
  symbol text not null,
  side text not null check (side in ('buy', 'panic_sell', 'take_profit', 'sell', 'skipped')),   -- skipped: its memory stopped it
  qty double precision not null,
  price double precision not null,
  eth double precision not null,                            -- ETH paid (buy) or received (sell), after the fee
  reason jsonb not null default '{}',                       -- {felt, did, dopamine, memory, tube, gains}
  value_after double precision not null,
  created_at timestamptz not null default now()
);
create index fly_trades_recent on public.fly_trades (id desc);
create index fly_trades_by_fly on public.fly_trades (fly_id, id desc);

-- each fly's traits (born with), what it has learned, its memory and tubes, and how its children inherit (minds.py)
create table public.fly_minds (
  fly_id uuid primary key references public.flies(id) on delete cascade,
  traits jsonb not null default '{}',
  learned jsonb not null default '{}',                      -- {gains: {target, threat, wind}, bias: {buy, ...}, pending}
  memory jsonb not null default '[]',                       -- [{state, action, reward}]
  tubes jsonb not null default '{}',                        -- {symbol: thickness}
  inherit text not null default 'partial' check (inherit in ('traits', 'partial', 'all')),
  stats jsonb not null default '{}',                        -- {rounds, rewards, good_trades, bad_trades, vetoes, dopamine}
  parents uuid[] not null default '{}',
  -- which learners the owner has switched on (POST /market/learning); babies start with all on
  learning jsonb not null default '{"dopamine": true, "memory": true, "tubes": true}',
  updated_at timestamptz not null default now()
);

-- pause/resume the market's training without a deploy: the worker skips rounds while paused; minds, memories and
-- portfolios stay as they are, so resuming carries on (worker/market_control.py pause|resume)
create table public.market_control (
  id int primary key default 1 check (id = 1),
  paused boolean not null default false,
  note text,
  updated_at timestamptz not null default now()
);
insert into public.market_control (id, paused) values (1, false) on conflict (id) do nothing;
alter table public.market_control enable row level security;
create policy "public read" on public.market_control for select using (true);

alter table public.market_coins enable row level security;
alter table public.market_rounds enable row level security;
alter table public.fly_portfolios enable row level security;
alter table public.fly_trades enable row level security;
alter table public.fly_minds enable row level security;
create policy "public read" on public.market_coins for select using (true);
create policy "public read" on public.market_rounds for select using (true);
create policy "public read" on public.fly_portfolios for select using (true);
create policy "public read" on public.fly_trades for select using (true);
create policy "public read" on public.fly_minds for select using (true);
alter publication supabase_realtime add table public.market_rounds, public.fly_trades;

create view public.trader_board with (security_invoker = on) as
  select p.fly_id, f.name, f.color, f.owner, f.generation, f.parents as fly_parents,
         p.eth, p.holdings, p.start_eth, p.value_eth, p.value_eth / nullif(p.start_eth, 0) - 1 as pnl, p.trades, p.updated_at,
         m.traits, m.inherit, m.stats, m.tubes, m.learning, m.learned -> 'gains' as gains, m.learned -> 'bias' as bias,
         jsonb_array_length(coalesce(m.memory, '[]'::jsonb)) as memories
  from public.fly_portfolios p
  join public.flies f on f.id = p.fly_id
  left join public.fly_minds m on m.fly_id = p.fly_id;
