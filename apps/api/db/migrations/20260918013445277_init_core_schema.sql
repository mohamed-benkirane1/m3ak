-- Up Migration

-- 1. customers
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  name TEXT,
  phone TEXT UNIQUE,
  city TEXT,
  preferred_language TEXT CHECK (preferred_language IN ('darija', 'arabic', 'french', 'mixed', 'unknown')),
  segment TEXT,
  imported_first_purchase_at DATE,
  imported_order_count INTEGER CHECK (imported_order_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. products (current catalogue truth)
CREATE TABLE products (
  ref TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  family TEXT NOT NULL,
  gender TEXT NOT NULL,
  color TEXT NOT NULL,
  size TEXT NOT NULL,
  material TEXT NOT NULL,
  season TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL CHECK (stock >= 0),
  barcode TEXT NOT NULL UNIQUE,
  weight_grams INTEGER NOT NULL CHECK (weight_grams >= 0),
  restock_delay_days INTEGER CHECK (restock_delay_days IS NULL OR restock_delay_days >= 0),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_family ON products (family);
CREATE INDEX idx_products_model ON products (model);
-- No UNIQUE(model, color, size): confirmed not unique in the source dataset.

-- 3. promotions (current catalogue truth, no invented external id)
CREATE TABLE promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_ref TEXT NOT NULL REFERENCES products (ref),
  normal_price_cents INTEGER NOT NULL CHECK (normal_price_cents >= 0),
  promo_price_cents INTEGER NOT NULL CHECK (promo_price_cents >= 0),
  starts_at DATE NOT NULL,
  ends_at DATE NOT NULL,
  condition TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_ref, starts_at, ends_at),
  CHECK (promo_price_cents <= normal_price_cents),
  CHECK (ends_at >= starts_at)
);
CREATE INDEX idx_promotions_window ON promotions (starts_at, ends_at);
-- No standalone product_ref index: UNIQUE(product_ref, starts_at, ends_at) already provides
-- a btree index with product_ref as its leading column, servable for "promotions for a product" lookups.

-- 4. delivery_zones (current delivery truth, independent of historical orders)
CREATE TABLE delivery_zones (
  city TEXT PRIMARY KEY,
  fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
  delay_hours SMALLINT NOT NULL CHECK (delay_hours > 0),
  cash_on_delivery BOOLEAN NOT NULL,
  store_pickup BOOLEAN NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. conversations (live M3AK state)
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers (id),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'escalated')),
  language TEXT NOT NULL CHECK (language IN ('darija', 'arabic', 'french', 'mixed', 'unknown')),
  langgraph_thread_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversations_customer_id ON conversations (customer_id);
CREATE INDEX idx_conversations_status ON conversations (status);
CREATE INDEX idx_conversations_updated_at ON conversations (updated_at);
-- No LangGraph checkpoint tables here: TASK-024 will use the official Postgres checkpointer.

-- 6. messages
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  role TEXT NOT NULL CHECK (role IN ('customer', 'assistant', 'merchant')),
  content TEXT NOT NULL CHECK (char_length(content) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_conversation_created ON messages (conversation_id, created_at);

-- 7. carts
CREATE TABLE carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  status TEXT NOT NULL CHECK (char_length(trim(status)) > 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_carts_conversation_id ON carts (conversation_id);
-- No CHECK vocabulary for status: the current Cart Zod contract intentionally leaves it
-- as a free non-empty string. No one-cart-per-conversation constraint added yet.

-- 8. cart_items
CREATE TABLE cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id UUID NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  product_ref TEXT NOT NULL REFERENCES products (ref),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cart_id, product_ref)
);
-- No standalone cart_id index: UNIQUE(cart_id, product_ref) already provides a btree index
-- with cart_id as its leading column, servable for "all items in a cart" lookups.

-- 9. orders (live M3AK operational orders only)
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers (id),
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  status TEXT NOT NULL CHECK (status IN ('confirmed')),
  products_total_cents INTEGER NOT NULL CHECK (products_total_cents >= 0),
  delivery_fee_cents INTEGER NOT NULL CHECK (delivery_fee_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  city TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash_on_delivery', 'bank_transfer', 'card')),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(trim(idempotency_key)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (total_cents = products_total_cents + delivery_fee_cents)
);
CREATE INDEX idx_orders_customer_id ON orders (customer_id);
CREATE INDEX idx_orders_conversation_id ON orders (conversation_id);
-- The total_cents invariant reflects the CURRENT model (no discount column yet).
-- A later order-level discount column would require revising this CHECK in a future migration.

-- 10. order_items (live)
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_ref TEXT NOT NULL REFERENCES products (ref),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);
CREATE INDEX idx_order_items_order_id ON order_items (order_id);
-- No UNIQUE(order_id, product_ref): each order line owns its own identity.

-- 11. historical_orders (immutable imported snapshot; never controls live workflow)
CREATE TABLE historical_orders (
  commande_id TEXT PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES customers (id),
  order_date DATE NOT NULL,
  canal TEXT NOT NULL CHECK (char_length(trim(canal)) > 0),
  historical_status TEXT NOT NULL CHECK (char_length(trim(historical_status)) > 0),
  products_total_cents INTEGER NOT NULL CHECK (products_total_cents >= 0),
  delivery_fee_cents INTEGER NOT NULL CHECK (delivery_fee_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  city TEXT NOT NULL CHECK (char_length(trim(city)) > 0),
  payment_method TEXT NOT NULL CHECK (char_length(trim(payment_method)) > 0),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (total_cents = products_total_cents + delivery_fee_cents)
);
CREATE INDEX idx_historical_orders_customer_id ON historical_orders (customer_id);
-- historical_status and payment_method remain free source text: never constrained to the
-- live OrderStatus/PaymentMethod enums.

-- 12. historical_order_items (immutable imported snapshot)
CREATE TABLE historical_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commande_id TEXT NOT NULL REFERENCES historical_orders (commande_id) ON DELETE CASCADE,
  product_ref TEXT NOT NULL,
  model TEXT NOT NULL,
  size TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  source_row_number INTEGER NOT NULL CHECK (source_row_number > 0)
);
CREATE INDEX idx_historical_order_items_commande_id ON historical_order_items (commande_id);
-- product_ref is intentionally NOT a FK to products(ref): historical snapshots must remain
-- preservable independently of future catalogue removal.
-- No business-field UNIQUE constraint: the source contains one exact duplicated business
-- row, and both occurrences must remain storable as two separate rows.

-- 13. escalations
CREATE TABLE escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  reason TEXT NOT NULL CHECK (char_length(reason) > 0),
  context_summary TEXT NOT NULL CHECK (char_length(context_summary) > 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX idx_escalations_conversation_id ON escalations (conversation_id);
CREATE INDEX idx_escalations_status ON escalations (status);

-- 14. followups
CREATE TABLE followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  scheduled_at TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'executed', 'cancelled', 'failed')),
  message TEXT,
  bullmq_job_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_followups_conversation_id ON followups (conversation_id);
CREATE INDEX idx_followups_status_scheduled_at ON followups (status, scheduled_at);
-- bullmq_job_id is only a correlation identifier: PostgreSQL remains durable truth (Redis/BullMQ never is).

-- 15. agent_events
CREATE TABLE agent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'node_started', 'intent_detected', 'tool_called', 'tool_succeeded', 'tool_failed',
    'guardrail_blocked', 'clarification_requested', 'escalation_created',
    'order_created', 'followup_scheduled'
  )),
  payload JSONB,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_events_conversation_created ON agent_events (conversation_id, created_at);
CREATE INDEX idx_agent_events_type ON agent_events (event_type);
-- payload holds public/auditable event metadata only: never chain-of-thought, hidden
-- prompts, secrets, or API keys.

-- Down Migration

DROP TABLE IF EXISTS agent_events;
DROP TABLE IF EXISTS followups;
DROP TABLE IF EXISTS escalations;
DROP TABLE IF EXISTS historical_order_items;
DROP TABLE IF EXISTS historical_orders;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS cart_items;
DROP TABLE IF EXISTS carts;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS delivery_zones;
DROP TABLE IF EXISTS promotions;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS customers;
