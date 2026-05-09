-- Profile customization: cartoon avatar, tagline, play-style tags
-- Run in Supabase SQL Editor

alter table public.profiles
  add column if not exists avatar_id      integer not null default 1,
  add column if not exists tagline        text    check (char_length(tagline) <= 50),
  add column if not exists selected_tags  text[]  not null default '{}';

-- avatar_url (for uploaded photo) already exists in schema.sql

-- Storage bucket for profile photos: create manually in Supabase dashboard
-- Bucket name: "avatars"  |  Public: true
-- Add policy: "Users upload own avatar"
--   INSERT with check: bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text
-- Add policy: "Public read avatars"
--   SELECT with check: bucket_id = 'avatars'
