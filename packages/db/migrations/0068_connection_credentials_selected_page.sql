-- 0068_connection_credentials_selected_page.sql
-- The Meta posting Page. Every Meta ad creative is posted FROM a Facebook Page
-- (object_story_spec.page_id), so the connect picker stores the founder's chosen Page here and
-- create_meta_creative defaults its pageId to it. Mirrors 0039's selected_pixel_id: non-secret
-- operational metadata queried WITHOUT decrypting encrypted_payload, nullable → existing rows
-- untouched, COALESCEd on re-connect so rotating a token never wipes the choice.
alter table connection_credentials
  add column if not exists selected_page_id text; -- Meta posting Page (NULL until chosen)
