-- Nutrition app ("התזונה שלי") tables in the shared Supabase project.
-- Run once in: Supabase Dashboard > SQL Editor > New query. Safe to run again.
-- Each user sees and changes only their own rows. Nothing here touches the home app's tables.

create table if not exists public.nutrition_state (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null,              -- targets, meals, plan, custom foods, weights...
  updated_at  timestamptz not null default now()
);

create table if not exists public.nutrition_days (
  user_id     uuid not null references auth.users(id) on delete cascade,
  day         date not null,
  data        jsonb not null,              -- { entries: [...], waterMl }
  updated_at  timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.nutrition_state enable row level security;
alter table public.nutrition_days  enable row level security;

drop policy if exists "own nutrition state" on public.nutrition_state;
create policy "own nutrition state" on public.nutrition_state
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own nutrition days" on public.nutrition_days;
create policy "own nutrition days" on public.nutrition_days
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Live sync between devices
do $$ begin
  alter publication supabase_realtime add table public.nutrition_state;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.nutrition_days;
exception when duplicate_object then null; end $$;
