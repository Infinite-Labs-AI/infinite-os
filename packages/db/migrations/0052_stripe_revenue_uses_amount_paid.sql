-- Gross revenue is cash Stripe actually collected, not the undiscounted face
-- value of invoice lines. A paid $0 test invoice can retain non-zero line
-- amounts, and a discounted invoice's lines can exceed amount_paid. Keeping the
-- view at invoice grain prevents both cases from inflating revenue.

create or replace view queryable.vw_revenue_by_source as
select
  i.workspace_id,
  i.source_id,
  'stripe'::text as provider,
  date(i.paid_at) as occurred_on,
  i.currency,
  i.external_order_id,
  i.stripe_customer_id as customer_external_id,
  i.stripe_invoice_id as invoice_external_id,
  null::text as product_external_id,
  null::text as price_external_id,
  i.amount_paid::numeric as recognized_revenue
from stripe_invoices i
where i.status = 'paid';

update queryable_views
set
  description = 'Stripe gross cash revenue authority view',
  row_grain = 'invoice',
  caveats = 'amount_paid_cash_collected;gross_of_refunds;content_linkage_not_implemented',
  updated_at = now()
where id = 'queryable.vw_revenue_by_source';

update metric_definitions
set
  name = 'Gross revenue',
  description = 'Cash collected on paid Stripe invoices',
  caveats = 'Stripe amount_paid;gross of later refunds;MRR is a separate recurring snapshot',
  version = version + 1
where id = 'recognized_revenue';
