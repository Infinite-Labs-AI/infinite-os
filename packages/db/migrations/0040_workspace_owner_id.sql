-- Solo single-device project ownership: stamp which cloud account (Supabase user id) owns a local
-- workspace. Nullable — pre-existing + CLI-born projects stay unowned until claimed from the desktop
-- (POST /projects/:id/claim). Identity is VERIFIED in the desktop/cloud layer; the open engine stays
-- cloud-agnostic — it records ownership, it does NOT verify a specific cloud's JWT.
alter table workspaces add column owner_id text;
