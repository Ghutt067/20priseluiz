-- Block 4: Purchase orders enhancements – delivery date
alter table purchase_orders
  add column if not exists expected_delivery_date date;
