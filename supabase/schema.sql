-- Restock database schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run once on a fresh project.

-- ============ Tables ============

create table households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'Home',
  invite_code text not null unique default upper(substr(md5(random()::text), 1, 6)),
  created_at  timestamptz not null default now()
);

create table members (
  household_id uuid not null references households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  display_name text,
  primary key (household_id, user_id)
);

-- A room holds spots (Fridge, Pantry...) as a small JSON list: [{ "id": "...", "name": "Fridge" }]
create table rooms (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name         text not null,
  sort         int  not null default 0,
  spots        jsonb not null default '[]'
);

-- One row per store LOCATION. Aisles in walking order: [{ "id": "...", "num": "12", "label": "Cereal" }]
create table stores (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  chain        text not null,
  location     text not null default '',
  sort         int  not null default 0,
  aisles       jsonb not null default '[]'
);

create table products (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name         text not null,
  brand        text not null default '',
  brand_only   boolean not null default false,  -- true = this brand only, false = other brands OK
  size         text not null default '',
  emoji        text not null default '🛒',
  photo_path   text,                            -- path in the "photos" storage bucket
  barcode      text,                            -- for Phase 2
  spot_id      text,                            -- id of a spot inside rooms.spots
  status       text not null default 'have' check (status in ('have','low','out')),
  skip         boolean not null default false,  -- out, but not needed right now
  extra        boolean not null default false,  -- on the list even though we have it
  got          boolean not null default false,  -- ticked off in the store
  count_mode   boolean not null default false,  -- track an exact count instead of have/low/out
  qty          int not null default 0,
  min_qty      int not null default 1,          -- "low at"
  target       int not null default 2,          -- "stock up to"
  only_at      text[] not null default '{}',    -- chains this is only bought at
  aisles       jsonb not null default '{}',     -- { "<store id>": "<aisle id>" }
  updated_at   timestamptz not null default now()
);

create index on rooms (household_id);
create index on stores (household_id);
create index on products (household_id);

-- ============ Security (row level security) ============
-- Only members of a household can see or change its data.

create or replace function is_member(hh uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where household_id = hh and user_id = auth.uid());
$$;

alter table households enable row level security;
alter table members    enable row level security;
alter table rooms      enable row level security;
alter table stores     enable row level security;
alter table products   enable row level security;

create policy "members read household" on households for select using (is_member(id));
create policy "members rename household" on households for update using (is_member(id));
create policy "members see members" on members for select using (is_member(household_id));
create policy "members manage rooms" on rooms for all using (is_member(household_id)) with check (is_member(household_id));
create policy "members manage stores" on stores for all using (is_member(household_id)) with check (is_member(household_id));
create policy "members manage products" on products for all using (is_member(household_id)) with check (is_member(household_id));

-- Creating and joining a household goes through these two functions only.
create or replace function create_household(hh_name text, my_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into households (name) values (coalesce(nullif(hh_name, ''), 'Home')) returning id into new_id;
  insert into members (household_id, user_id, display_name) values (new_id, auth.uid(), my_name);
  return new_id;
end; $$;

create or replace function join_household(code text, my_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare hh uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select id into hh from households where invite_code = upper(trim(code));
  if hh is null then raise exception 'invite code not found'; end if;
  insert into members (household_id, user_id, display_name) values (hh, auth.uid(), my_name)
    on conflict do nothing;
  return hh;
end; $$;

grant execute on function create_household(text, text) to authenticated;
grant execute on function join_household(text, text) to authenticated;

-- ============ Live sync ============
alter table rooms    replica identity full;
alter table stores   replica identity full;
alter table products replica identity full;
alter publication supabase_realtime add table rooms, stores, products;

-- ============ Photos ============
-- Private bucket. Files are stored as <household id>/<product id>.jpg
insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
  on conflict (id) do nothing;

create policy "household photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and is_member(((storage.foldername(name))[1])::uuid));
create policy "household photos write" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and is_member(((storage.foldername(name))[1])::uuid));
create policy "household photos update" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and is_member(((storage.foldername(name))[1])::uuid));
create policy "household photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and is_member(((storage.foldername(name))[1])::uuid));
