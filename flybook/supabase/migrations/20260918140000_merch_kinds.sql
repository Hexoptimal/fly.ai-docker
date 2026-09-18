-- Fly merch: the owner picks which products a design launches as (worker/merch.py PRODUCTS kinds). Null = all of them,
-- which is what designs paid before this column existed got.
alter table public.merch_designs add column kinds text[];
