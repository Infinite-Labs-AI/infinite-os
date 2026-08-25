delete from chat_memory_facts
where ctid in (
  select ctid
  from (
    select
      ctid,
      row_number() over (
        partition by workspace_id, scope, lower(fact)
        order by updated_at desc, created_at desc, id desc
      ) as duplicate_rank
    from chat_memory_facts
    where blocked_reason is null
  ) ranked_memory_facts
  where duplicate_rank > 1
);

create unique index chat_memory_facts_active_unique_idx
  on chat_memory_facts(workspace_id, scope, lower(fact))
  where blocked_reason is null;
