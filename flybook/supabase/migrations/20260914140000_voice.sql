-- Fly voices (2026-09-14): each post keeps what its fly's behaviour neurons did during the event, step by step,
-- so the app can play it as sound. {step_ms, groups: [escape, forward, backward, steer_left, steer_right, wing,
-- groom], counts: [[spikes per group] per step]}; 50 steps of 20 ms, about 0.5 KB. Written only by the worker.
alter table public.posts add column trace jsonb;
