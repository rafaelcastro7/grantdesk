-- A page that does not state a currency is the normal case, not an error.
--
-- client_profiles.currency was NOT NULL DEFAULT 'CAD', which reads fine until
-- extraction writes an explicit null for "the page did not say" — a DEFAULT
-- only applies when the column is omitted, so the insert failed with 23502 and
-- the whole profile was discarded. Making the honest answer representable is
-- the fix; inventing CAD for an organization we have not placed yet would be
-- exactly the kind of confident guess this product refuses to make.
alter table client_profiles alter column currency drop not null;
alter table client_profiles alter column currency drop default;
