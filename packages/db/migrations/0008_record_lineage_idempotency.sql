create unique index record_lineage_provider_row_unique
  on record_lineage(workspace_id, provider_table, provider_row_id, raw_record_id);
