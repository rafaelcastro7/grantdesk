-- persist() in src/server/match.ts used to delete this client's matches,
-- then insert the new ones, then insert their eligibility_checks, as three
-- separate round trips with no transaction and no lock. Two overlapping
-- runs for the same client (a double-clicked "Find matches", or a manual
-- run overlapping a profile-driven re-check) could interleave: both deletes
-- race, then both inserts land (duplicate rows per grant), or run B's
-- delete fires after run A's insert, silently wiping a result set the
-- consultant had just been told succeeded.
--
-- One function, one transaction, serialized per client by an advisory lock
-- held for the transaction's duration — a second overlapping call simply
-- waits its turn rather than interleaving with the first.
create or replace function replace_matches(
  target_client uuid,
  match_rows jsonb,
  matched_at timestamptz
)
returns void
language plpgsql as $$
declare
  row jsonb;
  check_row jsonb;
  new_match_id uuid;
begin
  -- hashtext(uuid) is stable for the lifetime of one transaction and one
  -- client is never running two of these concurrently against a different
  -- lock key, which is all this needs — advisory locks are session/
  -- transaction-scoped, not a general mutex, and pg_advisory_xact_lock
  -- releases automatically at commit or rollback either way.
  perform pg_advisory_xact_lock(hashtext(target_client::text));

  delete from matches where client_id = target_client;

  for row in select * from jsonb_array_elements(match_rows) loop
    insert into matches (client_id, grant_id, verdict, relevance, retrieval, matched_at)
    values (
      target_client,
      (row->>'grant_id')::uuid,
      row->>'verdict',
      nullif(row->>'relevance', '')::numeric,
      coalesce(row->'retrieval', '{}'::jsonb),
      matched_at
    )
    returning id into new_match_id;

    for check_row in select * from jsonb_array_elements(coalesce(row->'checks', '[]'::jsonb)) loop
      insert into eligibility_checks (match_id, rule_key, status, is_hard_gate, detail)
      values (
        new_match_id,
        check_row->>'rule_key',
        check_row->>'status',
        (check_row->>'is_hard_gate')::boolean,
        check_row->>'detail'
      );
    end loop;
  end loop;
end;
$$;

-- Same ownership boundary as the matches table itself — this only ever runs
-- as the signed-in consultant, and owns_client is the single choke point
-- every other table's RLS already calls through.
revoke all on function replace_matches(uuid, jsonb, timestamptz) from public;
grant execute on function replace_matches(uuid, jsonb, timestamptz) to authenticated;
