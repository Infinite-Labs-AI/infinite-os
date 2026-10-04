-- Missing provider reach is unknown, not measured zero. Preserve existing rows:
-- historical zero values cannot be reclassified without their original provider evidence.
alter table meta_ads_campaign_daily alter column reach drop not null;
alter table meta_ads_campaign_daily alter column reach drop default;
alter table meta_ads_adset_daily alter column reach drop not null;
alter table meta_ads_adset_daily alter column reach drop default;
alter table meta_ads_ad_daily alter column reach drop not null;
alter table meta_ads_ad_daily alter column reach drop default;
