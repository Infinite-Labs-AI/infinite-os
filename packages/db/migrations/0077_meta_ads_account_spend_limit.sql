-- The Meta ad account SPENDING LIMIT, stored from the account read the sync already makes.
--
-- `spend_cap` and `amount_spent` are fields of the ad account node, requested on the same
-- `GET /act_<id>` the sync makes for its identity/currency/timezone check (every full sync; at most once
-- per 24h on an inventory scan). No new request. CLOSE writes them together with that read's time.
--
-- Values are Meta's, exactly as returned, in the currency's BASIC unit per Meta's currency offset
-- (cents for USD/GBP/EUR; whole units for CLP, COP, CRC, HUF, ISK, IDR, JPY, KRW, PYG, TWD, VND), which
-- is not always the ISO 4217 minor unit:
--   spend_cap           the account spending limit; 0 or null means no limit is set (never a $0 limit).
--   amount_spent        spend Meta counts toward that limit; with no limit, the account's total spend.
--   spend_limit_read_at when the account node was read. NULL = never measured: a reader shows "—",
--                       never 0 and never "No limit".
--
-- Additive: three nullable columns on the existing per-account row; existing rows stay unmeasured
-- until their next account read. The table-level grants from 0069 cover the new columns.

alter table meta_ads_accounts add column if not exists spend_cap bigint;
alter table meta_ads_accounts add column if not exists amount_spent bigint;
alter table meta_ads_accounts add column if not exists spend_limit_read_at timestamptz;

-- A value without a read time does not exist, and Meta's amounts are never negative. Guarded like the
-- columns, so re-running this file (the cloud engine's one-call execute_sql recipe) is a no-op.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'meta_ads_accounts_spend_limit_check'
       and conrelid = 'meta_ads_accounts'::regclass
  ) then
    alter table meta_ads_accounts
      add constraint meta_ads_accounts_spend_limit_check
      check (
        (spend_cap is null or spend_cap >= 0)
        and (amount_spent is null or amount_spent >= 0)
        and (spend_limit_read_at is not null or (spend_cap is null and amount_spent is null))
      );
  end if;
end
$$;
