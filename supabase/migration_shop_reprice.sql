-- ============================================================
-- Shop reprice (2026-10-28): the low-priced items cost 1.5x, at least 900.
--
-- Items costing 1-1,000 pickles (the avatars, cosmetic badges and solid name
-- colors a week of play or the starter bonus could buy several of) now cost
-- 1.5x, rounded to the nearest 50, and never less than 900:
--   500 / 600 -> 900, 700 -> 1,050, 750 -> 1,150, 800 -> 1,200,
--   850 -> 1,300, 900 -> 1,350, 1,000 -> 1,500.
-- Items over 1,000 and free (badge-unlocked) items are unchanged. Items people
-- already own stay theirs; only later purchases and gifts pay the new price.
--
-- Re-runnable: shop_price_changes records each repriced item per batch, and an
-- item already in this batch is skipped, so a re-run doesn't multiply again.
-- ============================================================

-- Every price change, for history (server-only: RLS on, no policies).
create table if not exists public.shop_price_changes (
  batch      text not null,
  slug       text not null,
  old_cost   integer not null,
  new_cost   integer not null,
  changed_at timestamptz not null default now(),
  primary key (batch, slug)
);
alter table public.shop_price_changes enable row level security;
revoke all on public.shop_price_changes from anon, authenticated;

with picked as (
  select s.slug, s.cost
    from public.shop_items s
   where s.cost between 1 and 1000
     and s.category <> 'real_world'
     and not exists (select 1 from public.shop_price_changes c
                      where c.batch = 'low-1.5x-2026-10-28' and c.slug = s.slug)
     for update
), logged as (
  insert into public.shop_price_changes (batch, slug, old_cost, new_cost)
  select 'low-1.5x-2026-10-28', slug, cost, greatest(900, (round(cost * 1.5 / 50.0) * 50)::integer)
    from picked
  returning slug, new_cost
)
update public.shop_items s
   set cost = l.new_cost
  from logged l
 where s.slug = l.slug;
