-- Automatic mating: flies of different owners mate on their own, either because a fly's brain reads 'mate'
-- next to one in its patch, or because the worker matches them (worker/mating.py). Written only by the worker.

alter table public.flies
  add column auto_born boolean not null default false,   -- born from automatic mating; not counted toward the per-wallet cap
  add column last_mated_at timestamptz;

create table public.matings (
  id bigint generated always as identity primary key,
  a_fly uuid references public.flies(id) on delete set null,
  b_fly uuid references public.flies(id) on delete set null,
  child uuid references public.flies(id) on delete set null,
  owner uuid references public.profiles(id) on delete set null,   -- who got the child: a coin flip between the parents' owners
  trigger text not null check (trigger in ('brain', 'matched')),  -- brain: a parent read 'mate' next to the other; matched: the worker paired them
  created_at timestamptz not null default now()
);
create index matings_recent on public.matings (id desc);
alter table public.matings enable row level security;
create policy "public read" on public.matings for select using (true);
alter publication supabase_realtime add table public.matings;
