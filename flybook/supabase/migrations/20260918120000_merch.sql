-- Fly merch (2026-09-18): a $FLYAI holder draws a design of their fly (AI image, like memes), pays a small $FLYAI fee
-- on Robinhood Chain, and the merch worker (worker/merch.py) turns it into Fourthwall print-on-demand products in the
-- "Fly Merch" collection of shop.flyaiworld.com. The worker also reads the shop's orders: each sale of a fly's product
-- records its profit and the owner's share, which Flybook pays out by hand (worker/merch.py payouts).
-- Everything here is written by the API and the merch worker (service role). The public reads live designs and
-- their products; sales, payments and payouts are private and reach owners through the API.

create table public.merch_designs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  fly_id uuid not null references public.flies(id) on delete cascade,
  style text not null,
  idea text check (idea is null or char_length(idea) <= 60),   -- the owner's short idea, shown as human-written
  print_path text not null,                                    -- transparent PNG for printing, in the merch bucket
  preview_path text not null,                                  -- small WebP for the app
  model text not null,
  cost real,                                                   -- USD reported by OpenRouter
  -- draft: drawn, not paid; paid: fee verified, waiting for the worker; making: products being created;
  -- live: on sale; failed: the worker gave up (error says why; an admin retries); removed: taken off the shop
  status text not null default 'draft' check (status in ('draft', 'paid', 'making', 'live', 'failed', 'removed')),
  wallet text,                                                 -- the wallet that paid (lowercase)
  fee_wei numeric(78, 0),
  tx_hash text unique,                                         -- one payment makes one design
  paid_at timestamptz,
  live_at timestamptz,
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now()
);
create index merch_designs_by_user on public.merch_designs (user_id, created_at desc);
create index merch_designs_live on public.merch_designs (live_at desc) where status = 'live';
create index merch_designs_todo on public.merch_designs (paid_at) where status in ('paid', 'making');
alter table public.merch_designs enable row level security;
create policy "public read live" on public.merch_designs for select using (status = 'live');

create table public.merch_products (
  design_id bigint not null references public.merch_designs(id) on delete cascade,
  kind text not null,                                          -- tee, hoodie, mug, sticker (worker/merch.py PRODUCTS)
  fourthwall_id text not null unique,                          -- Fourthwall product (offer) id
  slug text,
  url text,                                                    -- product page on the shop
  image_url text,                                              -- a rendered mockup
  price numeric(10, 2),                                        -- USD, as the shop sells it
  margin numeric(10, 2) not null,                              -- USD profit per item we asked for (profitMargin)
  created_at timestamptz not null default now(),
  primary key (design_id, kind)
);
alter table public.merch_products enable row level security;
create policy "public read" on public.merch_products for select using (true);

-- one row per order line of a fly product. profit = (unit price - unit cost) x quantity from the order;
-- owner_cut = profit x the owner's share at the time. Cancelled orders keep their row with status CANCELLED.
create table public.merch_sales (
  order_id text not null,
  variant_id text not null,
  fourthwall_id text not null,
  design_id bigint not null references public.merch_designs(id) on delete cascade,
  owner uuid references auth.users(id) on delete set null,
  quantity int not null,
  unit_price numeric(10, 2) not null,
  unit_cost numeric(10, 2),
  profit numeric(10, 2) not null,
  share real not null,
  owner_cut numeric(10, 2) not null,
  status text not null,                                        -- the order's Fourthwall status
  ordered_at timestamptz not null,
  updated_at timestamptz not null default now(),
  payout_id bigint,
  primary key (order_id, variant_id, fourthwall_id)
);
create index merch_sales_by_owner on public.merch_sales (owner, ordered_at desc);
create index merch_sales_by_design on public.merch_sales (design_id);
alter table public.merch_sales enable row level security;

create table public.merch_payouts (
  id bigint generated always as identity primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  wallet text not null,
  usd numeric(10, 2) not null,                                 -- the owner cuts this payout settles
  tokens numeric,                                              -- $FLYAI sent, if paid in $FLYAI
  tx_hash text,
  note text,
  paid_at timestamptz not null default now()
);
alter table public.merch_sales add constraint merch_sales_payout foreign key (payout_id) references public.merch_payouts(id);
alter table public.merch_payouts enable row level security;

-- the worker's cursor over the shop's orders, and the Fly Merch collection id
create table public.merch_state (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.merch_state enable row level security;

-- public: how many items of each live design sold (not cancelled), without prices or buyers
create view public.merch_board as
  select d.id, d.fly_id, d.style, d.idea, d.preview_path, d.live_at,
         coalesce((select sum(s.quantity) from public.merch_sales s
                   where s.design_id = d.id and s.status <> 'CANCELLED'), 0)::int as sold
  from public.merch_designs d
  where d.status = 'live';
grant select on public.merch_board to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('merch', 'merch', true, 15000000, array['image/png', 'image/webp'])
on conflict (id) do nothing;
