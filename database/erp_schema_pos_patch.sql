-- Patch PDV
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pos_payment_status') then
    create type pos_payment_status as enum ('pending', 'paid', 'cancelled');
  end if;
end $$;

alter table pos_payments
  add column if not exists status pos_payment_status not null default 'paid';
