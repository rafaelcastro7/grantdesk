-- Split from 0010, which had already been applied. An applied migration is
-- history; editing it in place makes the file disagree with every database
-- that ran it, and the runner will not re-run it, so the edit silently does
-- nothing.

-- past_awards was write-only: every page view re-queried USAspending for an
-- answer we had already stored. A timestamp is what turns it into the cache it
-- was always meant to be.
alter table past_awards add column if not exists fetched_at timestamptz not null default now();
create index if not exists past_awards_fresh_idx on past_awards (assistance_listing, fetched_at desc);
