-- A group-chat incoming webhook (Discord/Slack) per league, used to post event
-- nudges into the chat the league already uses — the one channel that needs no
-- human tap. Own table rather than a leagues column because leagues are
-- world-readable ("Leagues are viewable by everyone") and a webhook URL is a
-- capability secret: anyone holding it can post to the channel.
create table if not exists public.league_chat_webhooks (
  league_id  uuid primary key references public.leagues(id) on delete cascade,
  url        text not null check (url like 'https://%'),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.league_chat_webhooks enable row level security;

-- Creator-only in every direction, mirroring "League creator can update" on
-- leagues itself. Members never read the URL; they see its effects in chat.
drop policy if exists "League creator manages chat webhook" on public.league_chat_webhooks;
create policy "League creator manages chat webhook" on public.league_chat_webhooks
  for all using (
    exists (select 1 from public.leagues l
             where l.id = league_chat_webhooks.league_id
               and l.created_by = auth.uid())
  )
  with check (
    exists (select 1 from public.leagues l
             where l.id = league_chat_webhooks.league_id
               and l.created_by = auth.uid())
  );
