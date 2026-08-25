-- Allow the "desktop" surface in chat_sessions. The /gateway/turn parity work (#40)
-- maps the request platform to a RuntimeSurface and now passes surface="desktop" for the
-- desktop app (RuntimeSurface gained "desktop" in #38). The original constraint
-- (0012_llm_runtime.sql) only allowed ('cli','api','app','mcp'), so a desktop chat turn
-- failed with chat_sessions_surface_check. Widen it to the full RuntimeSurface set
-- (also adds "worker", which the type has always carried but the constraint never did).
alter table chat_sessions drop constraint if exists chat_sessions_surface_check;
alter table chat_sessions add constraint chat_sessions_surface_check
  check (surface in ('cli', 'api', 'app', 'mcp', 'worker', 'desktop'));
