-- Fly market on real prices (2026-09-18): the coins are an allowlist of Robinhood Chain tokens at their live USD prices
-- (worker/prices.py), and the flies trade them with paper USDG. Nothing is bought or sold on chain. The portfolio and
-- trade columns keep their names (eth, value_eth, start_eth, cost_eth) but now hold paper dollars; market_coins.price
-- and market_rounds.prices are USD. worker/market_reset.py cleared the fake-ETH era's trades, rounds, fly coins and
-- learned state when this went live.

alter table public.market_coins
  add column address text,                         -- the token's contract on Robinhood Chain (chain id 4663)
  add column category text;                        -- major, meme or stock (prices.py)

comment on column public.market_coins.price is 'USD (real tokens, since 2026-09-18); fake ETH before';
comment on column public.fly_portfolios.eth is 'cash: paper USDG since 2026-09-18 (fake ETH before)';
comment on column public.fly_portfolios.value_eth is 'cash plus holdings at market, in paper USDG since 2026-09-18';
comment on column public.fly_trades.eth is 'paper USDG paid (buy) or received (sell), after the fee, since 2026-09-18';
