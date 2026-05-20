-- court_locations.nickname: optional friendly name shown instead of the
-- canonical `name` in the UI. Falls back to `name` when nickname is NULL.
-- The display layer (mobile/src/lib/courtNickname.ts) caches the lookup
-- and is used wherever a court name is rendered.

alter table public.court_locations add column if not exists nickname text;

update public.court_locations set nickname = 'The HUB Alameda'
 where name = 'Bladium Sports & Fitness Club';
