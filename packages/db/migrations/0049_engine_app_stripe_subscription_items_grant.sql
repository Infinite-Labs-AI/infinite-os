-- Cloud connector syncs run as engine_app. Migration 0048 granted that role
-- read access to the lifecycle views but omitted write access to their new
-- provider-truth table, so every cloud Stripe sync failed while loading items.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'engine_app') then
    grant select, insert, update on stripe_subscription_items to engine_app;
  end if;
end
$$;
