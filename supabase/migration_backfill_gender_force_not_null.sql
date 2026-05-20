-- Backfill the remaining NULL profiles.gender values (the original
-- migration_backfill_gender_by_name.sql left 20 users uncovered) and add
-- a NOT NULL constraint so the column can never go back to NULL.
--
-- Confident male/female assignments by first-name lookup; ambiguous names
-- (Ess, Jordan, Kha) become 'prefer-not-to-say' so doubles match
-- classification stays 'unspecified' until the user self-selects.
--
-- New signups: RegisterScreen client-side already requires gender. The
-- godmode-create-user edge function defaults to 'prefer-not-to-say'.
-- Both pass a value, so NOT NULL is safe.

update public.profiles set gender = case lower(split_part(trim(full_name), ' ', 1))
  when 'anthony'  then 'male'
  when 'barry'    then 'male'
  when 'james'    then 'male'
  when 'joshua'   then 'male'
  when 'justin'   then 'male'
  when 'mike'     then 'male'
  when 'sam'      then 'male'
  when 'sang'     then 'male'
  when 'vince'    then 'male'
  when 'april'    then 'female'
  when 'christine' then 'female'
  when 'lauren'   then 'female'
  when 'megan'    then 'female'
  when 'midori'   then 'female'
  when 'naomi'    then 'female'
  when 'priya'    then 'female'
  else 'prefer-not-to-say'
end
where gender is null;

update public.profiles set gender = 'prefer-not-to-say' where gender is null;

alter table public.profiles
  alter column gender set not null;
