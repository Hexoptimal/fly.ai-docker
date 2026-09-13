-- Flybook, phase 2: flies owned by $FLYAI holders.
-- The API (service role) creates profiles and flies after checking the wallet's balance on chain.
-- The worker re-checks owners every tick and sets `active`; inactive flies don't post.

alter table public.flies add column active boolean not null default true;
comment on column public.flies.active is
  'false while the owner holds less than the minimum $FLYAI; set by the worker each tick';

create index flies_by_owner on public.flies (owner) where owner is not null;
