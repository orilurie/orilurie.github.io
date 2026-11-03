-- Nutrition app: sharing with a coach (read-only), coach messages, and progress photos.
-- Run after supabase.sql. Safe to run again.

-- ---------- shares: owner lets viewer (a coach) see their data ----------
create table if not exists public.nutrition_shares (
  owner_id      uuid not null references auth.users(id) on delete cascade,
  viewer_id     uuid not null references auth.users(id) on delete cascade,
  owner_email   text,
  viewer_email  text,
  created_at    timestamptz not null default now(),
  primary key (owner_id, viewer_id)
);
alter table public.nutrition_shares enable row level security;

drop policy if exists "see own shares" on public.nutrition_shares;
create policy "see own shares" on public.nutrition_shares
  for select to authenticated using (owner_id = auth.uid() or viewer_id = auth.uid());
drop policy if exists "end own shares" on public.nutrition_shares;
create policy "end own shares" on public.nutrition_shares
  for delete to authenticated using (owner_id = auth.uid() or viewer_id = auth.uid());
-- Shares are created only through nutrition_share_add (it looks the viewer up by email).

create or replace function public.nutrition_share_add(viewer_email text)
returns json language plpgsql security definer set search_path = public, auth as $$
declare
  me uuid := auth.uid();
  v uuid;
  my_email text;
begin
  if me is null then return json_build_object('error', 'not_signed_in'); end if;
  select id into v from auth.users where lower(email) = lower(trim(viewer_email));
  if v is null then return json_build_object('error', 'no_user'); end if;
  if v = me then return json_build_object('error', 'self'); end if;
  select email into my_email from auth.users where id = me;
  insert into public.nutrition_shares (owner_id, viewer_id, owner_email, viewer_email)
    values (me, v, my_email, lower(trim(viewer_email)))
    on conflict do nothing;
  return json_build_object('ok', true);
end $$;
revoke all on function public.nutrition_share_add(text) from public, anon;
grant execute on function public.nutrition_share_add(text) to authenticated;

create or replace function public.nutrition_can_view(owner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.nutrition_shares where owner_id = owner and viewer_id = auth.uid());
$$;
revoke all on function public.nutrition_can_view(uuid) from public, anon;
grant execute on function public.nutrition_can_view(uuid) to authenticated;

-- Same check by folder name (text), so storage policies never cast other buckets' paths to uuid
create or replace function public.nutrition_can_view_folder(folder text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.nutrition_shares where owner_id::text = folder and viewer_id = auth.uid());
$$;
revoke all on function public.nutrition_can_view_folder(text) from public, anon;
grant execute on function public.nutrition_can_view_folder(text) to authenticated;

-- Viewers may read (never write) the owner's data
drop policy if exists "viewer reads nutrition state" on public.nutrition_state;
create policy "viewer reads nutrition state" on public.nutrition_state
  for select to authenticated using (public.nutrition_can_view(user_id));
drop policy if exists "viewer reads nutrition days" on public.nutrition_days;
create policy "viewer reads nutrition days" on public.nutrition_days
  for select to authenticated using (public.nutrition_can_view(user_id));

-- ---------- messages from a viewer to the owner ----------
create table if not exists public.nutrition_messages (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  author_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author_email  text default (auth.jwt() ->> 'email'),
  body          text not null check (length(body) between 1 and 2000),
  created_at    timestamptz not null default now(),
  read_at       timestamptz
);
create index if not exists nutrition_messages_owner on public.nutrition_messages (owner_id, created_at desc);
alter table public.nutrition_messages enable row level security;

drop policy if exists "read own messages" on public.nutrition_messages;
create policy "read own messages" on public.nutrition_messages
  for select to authenticated using (owner_id = auth.uid() or author_id = auth.uid());
drop policy if exists "viewer writes messages" on public.nutrition_messages;
create policy "viewer writes messages" on public.nutrition_messages
  for insert to authenticated with check (author_id = auth.uid() and public.nutrition_can_view(owner_id));
drop policy if exists "owner marks read" on public.nutrition_messages;
create policy "owner marks read" on public.nutrition_messages
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "author deletes message" on public.nutrition_messages;
create policy "author deletes message" on public.nutrition_messages
  for delete to authenticated using (author_id = auth.uid());
-- The owner may only change read_at
revoke update on public.nutrition_messages from authenticated;
grant update (read_at) on public.nutrition_messages to authenticated;

-- ---------- progress photos (private bucket, folder per user) ----------
insert into storage.buckets (id, name, public) values ('nutrition-photos', 'nutrition-photos', false)
  on conflict (id) do nothing;

drop policy if exists "nutrition photos: owner writes" on storage.objects;
create policy "nutrition photos: owner writes" on storage.objects
  for insert to authenticated with check (bucket_id = 'nutrition-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "nutrition photos: owner deletes" on storage.objects;
create policy "nutrition photos: owner deletes" on storage.objects
  for delete to authenticated using (bucket_id = 'nutrition-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "nutrition photos: owner and viewers read" on storage.objects;
create policy "nutrition photos: owner and viewers read" on storage.objects
  for select to authenticated using (
    bucket_id = 'nutrition-photos' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.nutrition_can_view_folder((storage.foldername(name))[1])
    )
  );
