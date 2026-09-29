-- What a consultant needs next after "may we apply": the funder's own
-- guidelines and forms, and who to ask. Stored as the funder published them.
alter table grants add column if not exists documents jsonb not null default '[]'::jsonb;
alter table grants add column if not exists contact text;

comment on column grants.documents is
  'Guidelines, forms and application guides linked by the funder: [{label, url}].';
comment on column grants.contact is 'Program contact as published by the funder.';
