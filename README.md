# Mokio Messages

Uses the same Mokio profiles database as mokio.online.
Only tester and owner accounts can sign in.

## Host
1. Create a GitHub repo
2. Upload every file in this folder
3. Settings → Pages → main / root

## Required SQL
```sql
create or replace function public.find_user_handle(handle text)
returns table (id uuid, email text, username text)
language sql
security definer
stable
set search_path = public
as $$
  select p.id, p.email, p.username
  from public.profiles p
  where lower(p.username) = lower(handle)
     or lower(p.email) = lower(handle)
  limit 1;
$$;

create or replace function public.find_user_id(uid uuid)
returns table (id uuid, email text, username text)
language sql
security definer
stable
set search_path = public
as $$
  select p.id, p.email, p.username
  from public.profiles p
  where p.id = uid
  limit 1;
$$;

grant execute on function public.find_user_handle(text) to authenticated, anon;
grant execute on function public.find_user_id(uuid) to authenticated, anon;
```
