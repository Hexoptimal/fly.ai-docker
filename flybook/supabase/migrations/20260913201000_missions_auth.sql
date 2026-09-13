-- Functions are executable by PUBLIC by default, which includes anon; missions are for signed-in users only.
-- season_points stays public: the season_board view calls it for everyone.
revoke execute on function public.my_missions() from public;
revoke execute on function public.my_missions() from anon;
grant execute on function public.my_missions() to authenticated;
