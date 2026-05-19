-- Godmode helper: set a player's four PLUPR values without touching match
-- history. Match-related triggers will re-affect these values on the next
-- match insert; this is for quick test-account adjustments.

create or replace function public.godmode_set_plupr(
  p_user_id  uuid,
  p_overall  numeric,
  p_singles  numeric,
  p_doubles  numeric,
  p_mixed    numeric
)
returns table (
  user_id              uuid,
  rating               numeric,
  singles_rating       numeric,
  doubles_rating       numeric,
  mixed_doubles_rating numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  if uid not in ('252a36e1-5d89-4ad2-8a3e-b786579f019a') then
    raise exception 'Forbidden — godmode only';
  end if;
  if p_user_id is null then raise exception 'p_user_id required'; end if;

  update profiles
     set rating               = coalesce(p_overall, rating),
         singles_rating       = coalesce(p_singles, singles_rating),
         doubles_rating       = coalesce(p_doubles, doubles_rating),
         mixed_doubles_rating = coalesce(p_mixed,   mixed_doubles_rating)
   where id = p_user_id;

  return query
    select id, rating, singles_rating, doubles_rating, mixed_doubles_rating
      from profiles where id = p_user_id;
end;
$$;

grant execute on function public.godmode_set_plupr(uuid, numeric, numeric, numeric, numeric) to authenticated;
