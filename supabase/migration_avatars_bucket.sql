-- ============================================================
-- Create the `avatars` storage bucket, which the app has always assumed exists.
--
-- AvatarPickerModal.tsx uploads a profile photo to `avatars/<user id>/avatar.<ext>`
-- and writes the public URL to profiles.avatar_url. The bucket was never
-- created, so every upload has failed with the modal's own fallback message
-- ("Check that the 'avatars' storage bucket exists in Supabase") — verified in
-- production: storage.buckets is empty, storage.objects is empty, and zero
-- profiles have a non-null avatar_url. The emoji avatars have been carrying the
-- whole feature.
--
-- This matters beyond the broken feature: NSPhotoLibraryUsageDescription is
-- declared and the App Review notes point a reviewer at "set a profile picture"
-- as one of the permission prompts to try.
--
-- Paths are `<user id>/...`, so ownership is decided by the first path segment
-- rather than by storage.objects.owner — an upsert from the same user keeps the
-- same path, and the folder convention survives re-uploads.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars', 'avatars', true,
  5 * 1024 * 1024,                       -- 5 MB: a profile photo, not a gallery
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Read: the bucket is public, and profile photos are shown to other players.
drop policy if exists "Avatar images are publicly readable" on storage.objects;
create policy "Avatar images are publicly readable" on storage.objects
  for select using (bucket_id = 'avatars');

-- Write: only into your own folder.
drop policy if exists "Users upload their own avatar"  on storage.objects;
drop policy if exists "Users replace their own avatar" on storage.objects;
drop policy if exists "Users delete their own avatar"  on storage.objects;

create policy "Users upload their own avatar" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users replace their own avatar" on storage.objects
  for update to authenticated using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users delete their own avatar" on storage.objects
  for delete to authenticated using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Takedown: the moderator can remove someone else's photo. Storage refuses
-- DELETE on storage.objects from SQL ("Direct deletion from storage tables is
-- not allowed. Use the Storage API instead."), which is why this is a policy
-- for the client's Storage API call rather than a line in a SECURITY DEFINER
-- function — see migration_moderation_report_block.sql §5a.
drop policy if exists "Moderator removes any avatar" on storage.objects;
create policy "Moderator removes any avatar" on storage.objects
  for delete to authenticated using (
    bucket_id = 'avatars' and public.is_godmode_user()
  );
