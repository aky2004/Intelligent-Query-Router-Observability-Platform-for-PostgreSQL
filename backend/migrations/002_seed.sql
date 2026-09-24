-- =============================================================================
-- Ping-Pooler Test Database Seed  (v2 — idempotent, no FK type conflicts)
-- Run: psql "$PRIMARY_DATABASE_URL" -f backend/migrations/002_seed.sql
-- =============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 0. CLEAN SLATE — drop our test tables in dependency order
-- =============================================================================
DROP TABLE IF EXISTS pool_snapshots   CASCADE;
DROP TABLE IF EXISTS anomaly_log      CASCADE;
DROP TABLE IF EXISTS query_log        CASCADE;
DROP TABLE IF EXISTS order_items      CASCADE;
DROP TABLE IF EXISTS orders           CASCADE;
DROP TABLE IF EXISTS products         CASCADE;
DROP TABLE IF EXISTS users            CASCADE;

DROP TABLE IF EXISTS refresh_sessions CASCADE;
DROP TABLE IF EXISTS user_roles       CASCADE;
DROP TABLE IF EXISTS profiles         CASCADE;
DROP TABLE IF EXISTS app_users        CASCADE;

DROP TYPE IF EXISTS app_role CASCADE;

-- =============================================================================
-- 1. AUTH TABLES
-- =============================================================================
CREATE TABLE app_users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL UNIQUE,
  password_hash     text NOT NULL,
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  user_id      uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  avatar_url   text,
  preferences  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE app_role AS ENUM ('admin', 'operator', 'viewer');
CREATE TABLE user_roles (
  user_id uuid      NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role    app_role  NOT NULL DEFAULT 'viewer',
  PRIMARY KEY (user_id, role)
);

CREATE TABLE refresh_sessions (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  user_agent  text,
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_sessions_user_idx   ON refresh_sessions(user_id);
CREATE INDEX refresh_sessions_family_idx ON refresh_sessions(family_id);

-- =============================================================================
-- 2. DOMAIN TABLES (no cross-table FKs to avoid type-mismatch on existing DBs)
-- =============================================================================

CREATE TABLE users (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  full_name  text NOT NULL,
  phone      text,
  country    text NOT NULL DEFAULT 'US',
  tier       text NOT NULL DEFAULT 'free' CHECK (tier IN ('free','pro','enterprise')),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id           bigserial PRIMARY KEY,
  sku          text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text,
  category     text NOT NULL,
  price_cents  integer NOT NULL CHECK (price_cents >= 0),
  stock_qty    integer NOT NULL DEFAULT 0,
  is_available boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- user_id stored as bigint with no FK constraint (avoids type conflicts)
CREATE TABLE orders (
  id               bigserial PRIMARY KEY,
  user_id          bigint NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','paid','shipped','delivered','cancelled','refunded')),
  total_cents      integer NOT NULL CHECK (total_cents >= 0),
  currency         text NOT NULL DEFAULT 'USD',
  shipping_address jsonb,
  notes            text,
  placed_at        timestamptz NOT NULL DEFAULT now(),
  shipped_at       timestamptz,
  delivered_at     timestamptz
);

CREATE TABLE order_items (
  id             bigserial PRIMARY KEY,
  order_id       bigint NOT NULL,   -- soft FK to orders
  product_id     bigint NOT NULL,   -- soft FK to products
  quantity       integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL,
  discount_pct   numeric(5,2) NOT NULL DEFAULT 0
);

CREATE TABLE query_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sql         text NOT NULL,
  duration_ms numeric(10,3) NOT NULL,
  row_count   integer,
  routed_to   text NOT NULL,
  session_id  text,
  status      text NOT NULL DEFAULT 'success' CHECK (status IN ('success','error')),
  error_msg   text,
  executed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pool_snapshots (
  id                  bigserial PRIMARY KEY,
  node_id             text NOT NULL,
  total_connections   integer NOT NULL,
  idle_connections    integer NOT NULL,
  active_connections  integer NOT NULL,
  waiting_requests    integer NOT NULL DEFAULT 0,
  pressure            numeric(5,4) NOT NULL DEFAULT 0,
  snapshot_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE anomaly_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity     text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  category     text NOT NULL,
  message      text NOT NULL,
  query_sql    text,
  risk_score   numeric(4,3),
  acknowledged boolean NOT NULL DEFAULT false,
  detected_at  timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 3. INDEXES
-- =============================================================================
CREATE INDEX users_email_idx        ON users(email);
CREATE INDEX users_tier_idx         ON users(tier);
CREATE INDEX users_country_idx      ON users(country);
CREATE INDEX orders_user_id_idx     ON orders(user_id);
CREATE INDEX orders_status_idx      ON orders(status);
CREATE INDEX orders_placed_at_idx   ON orders(placed_at DESC);
CREATE INDEX order_items_order_idx  ON order_items(order_id);
CREATE INDEX order_items_prod_idx   ON order_items(product_id);
CREATE INDEX products_category_idx  ON products(category);
CREATE INDEX products_sku_idx       ON products(sku);
CREATE INDEX query_log_at_idx       ON query_log(executed_at DESC);
CREATE INDEX pool_snap_node_idx     ON pool_snapshots(node_id, snapshot_at DESC);

-- =============================================================================
-- 4. USERS (100)
-- =============================================================================
INSERT INTO users (email, full_name, phone, country, tier, is_active, created_at)
SELECT
  'user' || n || '@example.com',
  (ARRAY['Alice','Bob','Carol','Dave','Eve','Frank','Grace','Heidi','Ivan','Judy'])[(n-1)%10+1]
    || ' ' ||
  (ARRAY['Smith','Jones','Williams','Brown','Taylor','Wilson','Davis','Evans','Martin','Lee'])[(n-1)%10+1],
  '+1-555-' || LPAD(n::text, 4, '0'),
  (ARRAY['US','GB','DE','FR','IN','JP','CA','AU','BR','SG'])[n%10+1],
  (ARRAY['free','free','free','pro','pro','enterprise'])[n%6+1],
  (n % 11 != 0),
  now() - (random() * interval '365 days')
FROM generate_series(1, 100) AS t(n);

-- =============================================================================
-- 5. PRODUCTS (40)
-- =============================================================================
INSERT INTO products (sku, name, description, category, price_cents, stock_qty, is_available)
VALUES
  ('SKU-C001','Connection Pooler Pro','High-performance PostgreSQL connection pooler','Cloud',4999,999,true),
  ('SKU-C002','Query Router Enterprise','AI-powered read/write query splitter','Cloud',12999,999,true),
  ('SKU-C003','Redis Cache Layer','Managed Redis caching with hot-standby','Cloud',2999,999,true),
  ('SKU-C004','Replication Monitor','Real-time lag monitoring & alerting','Cloud',1999,999,true),
  ('SKU-C005','Auto-Vacuum Tuner','ML-based VACUUM scheduling optimizer','Cloud',3499,999,true),
  ('SKU-C006','Slow Query Analyzer','AI suggestions for N+1 and missing indexes','Cloud',2499,999,true),
  ('SKU-C007','Schema Diff Tool','Zero-downtime migration planner','Cloud',5999,999,true),
  ('SKU-C008','PITR Manager','Point-in-time recovery orchestration','Cloud',8999,999,true),
  ('SKU-C009','Logical Replication Kit','CDC pipeline builder','Cloud',6999,999,true),
  ('SKU-C010','Partitioning Wizard','Auto partition management','Cloud',3999,999,true),
  ('SKU-C011','Query Cache Warmer','Predictive cache pre-warming','Cloud',2499,999,true),
  ('SKU-C012','Connection Limiter','Per-role connection quotas','Cloud',1499,999,true),
  ('SKU-C013','Failover Orchestrator','Automatic primary promotion','Cloud',11999,999,true),
  ('SKU-C014','WAL Shipper','Streaming WAL to S3','Cloud',4999,999,true),
  ('SKU-C015','Connection Proxy','PgBouncer-compatible proxy','Cloud',0,999,true),
  ('SKU-A001','Dashboard Starter','Essential metrics dashboard','Analytics',0,999,true),
  ('SKU-A002','Dashboard Pro','Advanced analytics with custom alerts','Analytics',1999,999,true),
  ('SKU-A003','Timeseries Explorer','Interactive time-series charts','Analytics',2999,999,true),
  ('SKU-A004','Anomaly Detector','ML-based anomaly detection','Analytics',4999,999,true),
  ('SKU-A005','Capacity Planner','Predictive resource utilization','Analytics',3499,999,true),
  ('SKU-A006','Report Builder','Scheduled PDF/CSV exports','Analytics',1499,999,true),
  ('SKU-A007','Live Query Monitor','Real-time pg_stat_activity viewer','Analytics',999,999,true),
  ('SKU-A008','Index Advisor','EXPLAIN-based index recommendations','Analytics',3499,999,true),
  ('SKU-A009','Cost Analyzer','Cloud DB spend optimizer','Analytics',2999,999,true),
  ('SKU-S001','SQL Firewall','DeepSeek-powered injection blocker','Security',9999,999,true),
  ('SKU-S002','Audit Log','Tamper-proof query audit trail','Security',3999,999,true),
  ('SKU-S003','Row-Level Security','Policy management UI','Security',5999,999,true),
  ('SKU-S004','Credential Vault','Encrypted secrets management','Security',4499,999,true),
  ('SKU-S005','GDPR Toolkit','Data masking + right-to-erasure','Security',7999,999,true),
  ('SKU-S006','SOC2 Audit Helper','Automated compliance evidence','Security',14999,999,true),
  ('SKU-P001','Community Support','Forum + docs access','Support',0,999,true),
  ('SKU-P002','Email Support','24h response SLA','Support',499,999,true),
  ('SKU-P003','Priority Support','4h response SLA','Support',1999,999,true),
  ('SKU-P004','Dedicated Engineer','Named DBA on-call','Support',49999,50,true),
  ('SKU-P005','Migration Service','Hands-on DB migration','Support',99999,20,true),
  ('SKU-H001','NVMe SSD Pack','512GB NVMe for WAL offload','Hardware',15999,42,true),
  ('SKU-H002','10GbE NIC','Low-latency network card','Hardware',8999,15,true),
  ('SKU-H003','ECC RAM Module','32GB ECC DDR5','Hardware',22999,8,false),
  ('SKU-H004','Raspberry Pi Cluster','4-node Pi5 test cluster','Hardware',39999,5,true),
  ('SKU-H005','Server Rack Unit','2U rackmount server','Hardware',149999,3,true);

-- =============================================================================
-- 6. ORDERS (300 — user_id refs users.id 1-100)
-- =============================================================================
INSERT INTO orders (user_id, status, total_cents, currency, shipping_address, placed_at, shipped_at, delivered_at)
SELECT
  (n % 100) + 1,
  (ARRAY['pending','paid','shipped','delivered','delivered','delivered','cancelled','refunded'])[floor(random()*8)+1],
  (1000 + floor(random() * 99000))::integer,
  'USD',
  jsonb_build_object(
    'street', (floor(random()*9000)+100)::text || ' Main St',
    'city',   (ARRAY['New York','London','Berlin','Paris','Tokyo','Sydney','Toronto','Mumbai'])[floor(random()*8)+1],
    'zip',    LPAD((floor(random()*90000)+10000)::text, 5, '0')
  ),
  now() - (random() * interval '90 days'),
  CASE WHEN random() > 0.3 THEN now() - (random() * interval '80 days') ELSE NULL END,
  CASE WHEN random() > 0.5 THEN now() - (random() * interval '60 days') ELSE NULL END
FROM generate_series(1, 300) AS t(n);

-- =============================================================================
-- 7. ORDER ITEMS (1-4 items per order, refs orders.id & products.id)
-- =============================================================================
INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents, discount_pct)
SELECT
  o.id,
  ((o.id + gen.n) % 40) + 1,
  (floor(random()*4)+1)::integer,
  (500 + floor(random()*10000))::integer,
  (ARRAY[0,0,0,5,10,15,20])[floor(random()*7)+1]
FROM orders o
CROSS JOIN generate_series(1, (floor(random()*3)+1)::integer) AS gen(n);

-- =============================================================================
-- 8. QUERY LOG (500 entries — realistic SQL mix)
-- =============================================================================
INSERT INTO query_log (sql, duration_ms, row_count, routed_to, session_id, status, executed_at)
SELECT
  (ARRAY[
    'SELECT * FROM users WHERE tier = ''pro'' LIMIT 25',
    'SELECT COUNT(*) FROM orders WHERE status = ''pending''',
    'SELECT u.full_name, COUNT(o.id) FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.id LIMIT 20',
    'SELECT p.name, SUM(oi.quantity) FROM products p JOIN order_items oi ON oi.product_id = p.id GROUP BY p.id LIMIT 10',
    'SELECT * FROM orders WHERE placed_at > now() - interval ''7 days'' LIMIT 50',
    'SELECT AVG(total_cents), MAX(total_cents) FROM orders WHERE status = ''delivered''',
    'SELECT country, COUNT(*) FROM users GROUP BY country ORDER BY 2 DESC',
    'UPDATE orders SET status = ''shipped'' WHERE id = $1',
    'INSERT INTO query_log (sql,duration_ms,row_count,routed_to,status) VALUES ($1,$2,$3,$4,''success'')',
    'SELECT id, email FROM users WHERE is_active = true AND tier = ''enterprise'' LIMIT 10',
    'SELECT * FROM products WHERE category = ''Cloud'' AND is_available = true ORDER BY price_cents ASC',
    'SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = ''paid'' LIMIT 30',
    'SELECT DATE_TRUNC(''day'', placed_at), COUNT(*), SUM(total_cents) FROM orders GROUP BY 1 ORDER BY 1 DESC LIMIT 30',
    'SELECT * FROM anomaly_log WHERE severity = ''high'' ORDER BY detected_at DESC LIMIT 10',
    'SELECT node_id, AVG(pressure) FROM pool_snapshots WHERE snapshot_at > now() - interval ''1 hour'' GROUP BY node_id',
    'BEGIN',
    'COMMIT',
    'SELECT id FROM users WHERE email = $1',
    'DELETE FROM refresh_sessions WHERE expires_at < now()',
    'SELECT COUNT(*) FROM products WHERE category = ''Security'''
  ])[floor(random()*20)+1],
  (2 + random() * 498)::numeric(10,3),
  floor(random() * 200)::integer,
  CASE WHEN random() > 0.25 THEN 'primary' ELSE 'replica-1' END,
  'session-' || (floor(random()*20)+1)::text,
  CASE WHEN random() < 0.08 THEN 'error' ELSE 'success' END,  -- ~8% error rate
  now() - (random() * interval '24 hours')
FROM generate_series(1, 500);

-- =============================================================================
-- 9. POOL SNAPSHOTS (7 days of 5-min intervals × 2 nodes)
-- =============================================================================
INSERT INTO pool_snapshots (node_id, total_connections, idle_connections, active_connections, waiting_requests, pressure, snapshot_at)
SELECT
  node_id,
  max_conn,
  floor(random() * (max_conn * 0.6))::integer,
  floor(random() * (max_conn * 0.4))::integer,
  floor(random() * 3)::integer,
  round(LEAST(1.0, random() * 0.7)::numeric, 4),
  ts
FROM
  (VALUES ('primary', 20), ('replica-1', 15)) AS n(node_id, max_conn),
  generate_series(
    now() - interval '7 days',
    now(),
    interval '5 minutes'
  ) AS t(ts);

-- =============================================================================
-- 10. ANOMALY LOG (10 realistic alerts)
-- =============================================================================
INSERT INTO anomaly_log (severity, category, message, query_sql, risk_score, acknowledged, detected_at)
VALUES
  ('critical','sql_injection','SQL injection attempt: OR 1=1 tautology','SELECT * FROM users WHERE id=1 OR 1=1',0.97,true, now()-interval '6 hours'),
  ('high','slow_query','Query exceeded 2000ms on primary','SELECT * FROM orders o JOIN users u ON u.id=o.user_id WHERE u.country=''US''',0.0,true, now()-interval '5 hours'),
  ('high','connection_surge','Connection pool hit 92% utilization on primary','',0.0,false, now()-interval '4 hours'),
  ('medium','replica_lag','Replica lag reached 1842ms — near threshold','',0.0,true, now()-interval '3 hours'),
  ('medium','slow_query','Missing index on orders.status','SELECT COUNT(*) FROM orders WHERE status=''pending'' AND total_cents > 5000',0.0,false, now()-interval '2 hours'),
  ('low','anomaly','Unusual query shape — similarity 0.41','SELECT * FROM products WHERE sku LIKE ''%DROP%''',0.61,false, now()-interval '90 minutes'),
  ('high','sql_injection','pg_sleep injection blocked','SELECT id FROM users WHERE id=1; SELECT pg_sleep(5)--',0.94,false, now()-interval '60 minutes'),
  ('low','slow_query','Seq scan on users without index','SELECT * FROM users WHERE phone = $1',0.0,false, now()-interval '30 minutes'),
  ('medium','anomaly','DELETE without WHERE intercepted','DELETE FROM orders',0.88,false, now()-interval '15 minutes'),
  ('low','replica_lag','Replica lag spike 950ms during peak load','',0.0,false, now()-interval '5 minutes');

-- =============================================================================
-- 11. APP_USERS (4 test dashboard accounts)
-- =============================================================================
INSERT INTO app_users (email, password_hash, email_verified_at) VALUES
  ('admin@ping-pooler.com',    crypt('Admin123!',   gen_salt('bf', 12)), now()),
  ('operator@ping-pooler.com', crypt('Operator1!',  gen_salt('bf', 12)), now()),
  ('viewer@ping-pooler.com',   crypt('Viewer123!',  gen_salt('bf', 12)), now()),
  ('dev@ping-pooler.com',      crypt('Dev12345!',   gen_salt('bf', 12)), now());

INSERT INTO profiles (user_id, display_name, avatar_url, preferences)
SELECT id,
  split_part(email,'@',1),
  'https://api.dicebear.com/7.x/initials/svg?seed=' || split_part(email,'@',1),
  '{}'::jsonb
FROM app_users;

INSERT INTO user_roles (user_id, role)
SELECT id, 'admin'    FROM app_users WHERE email = 'admin@ping-pooler.com';
INSERT INTO user_roles (user_id, role)
SELECT id, 'operator' FROM app_users WHERE email = 'operator@ping-pooler.com';
INSERT INTO user_roles (user_id, role)
SELECT id, 'viewer'   FROM app_users WHERE email = 'viewer@ping-pooler.com';
INSERT INTO user_roles (user_id, role)
SELECT id, 'operator' FROM app_users WHERE email = 'dev@ping-pooler.com';

-- =============================================================================
-- 12. VERIFY
-- =============================================================================
DO $$
DECLARE
  v_users bigint; v_prod bigint; v_orders bigint; v_items bigint;
  v_qlog  bigint; v_snap bigint; v_anom  bigint; v_au   bigint;
BEGIN
  SELECT COUNT(*) INTO v_users  FROM users;
  SELECT COUNT(*) INTO v_prod   FROM products;
  SELECT COUNT(*) INTO v_orders FROM orders;
  SELECT COUNT(*) INTO v_items  FROM order_items;
  SELECT COUNT(*) INTO v_qlog   FROM query_log;
  SELECT COUNT(*) INTO v_snap   FROM pool_snapshots;
  SELECT COUNT(*) INTO v_anom   FROM anomaly_log;
  SELECT COUNT(*) INTO v_au     FROM app_users;
  RAISE NOTICE '=== Seed Complete ===';
  RAISE NOTICE 'users:          %', v_users;
  RAISE NOTICE 'products:       %', v_prod;
  RAISE NOTICE 'orders:         %', v_orders;
  RAISE NOTICE 'order_items:    %', v_items;
  RAISE NOTICE 'query_log:      %', v_qlog;
  RAISE NOTICE 'pool_snapshots: %', v_snap;
  RAISE NOTICE 'anomaly_log:    %', v_anom;
  RAISE NOTICE 'app_users:      %', v_au;
END $$;
