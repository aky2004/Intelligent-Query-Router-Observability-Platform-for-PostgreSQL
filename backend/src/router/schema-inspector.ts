import { databaseConfig } from "../config/database";
import { getNodes, getPrimary, runOnNode } from "./pool-manager";
import { logger } from "../utils/logger";
import { nowIso } from "../utils/helpers";

export interface ColumnDetail {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  references: {
    table: string;
    column: string;
  } | null;
}

export interface TableDetail {
  name: string;
  estimatedRows: number;
  columns: ColumnDetail[];
}

export interface SchemaInspectionResult {
  databaseName: string;
  serverVersion?: string;
  isSimulated: boolean;
  hasConnectedPrimary: boolean;
  tables: TableDetail[];
  totalTables: number;
  totalEstimatedRows: number;
  inspectedAt: string;
}

const SAMPLE_SIMULATED_TABLES: TableDetail[] = [
  {
    name: "app_users",
    estimatedRows: 1240,
    columns: [
      { name: "id", type: "uuid", nullable: false, defaultValue: "gen_random_uuid()", isPrimaryKey: true, references: null },
      { name: "email", type: "character varying", nullable: false, defaultValue: null, isPrimaryKey: false, references: null },
      { name: "display_name", type: "character varying", nullable: false, defaultValue: null, isPrimaryKey: false, references: null },
      { name: "role", type: "character varying", nullable: false, defaultValue: "'viewer'", isPrimaryKey: false, references: null },
      { name: "created_at", type: "timestamp with time zone", nullable: false, defaultValue: "now()", isPrimaryKey: false, references: null },
    ],
  },
  {
    name: "profiles",
    estimatedRows: 1240,
    columns: [
      { name: "id", type: "uuid", nullable: false, defaultValue: "gen_random_uuid()", isPrimaryKey: true, references: null },
      { name: "user_id", type: "uuid", nullable: false, defaultValue: null, isPrimaryKey: false, references: { table: "app_users", column: "id" } },
      { name: "avatar_url", type: "text", nullable: true, defaultValue: null, isPrimaryKey: false, references: null },
      { name: "preferences", type: "jsonb", nullable: false, defaultValue: "'{}'::jsonb", isPrimaryKey: false, references: null },
      { name: "updated_at", type: "timestamp with time zone", nullable: false, defaultValue: "now()", isPrimaryKey: false, references: null },
    ],
  },
  {
    name: "orders",
    estimatedRows: 8530,
    columns: [
      { name: "id", type: "uuid", nullable: false, defaultValue: "gen_random_uuid()", isPrimaryKey: true, references: null },
      { name: "user_id", type: "uuid", nullable: false, defaultValue: null, isPrimaryKey: false, references: { table: "app_users", column: "id" } },
      { name: "total_cents", type: "integer", nullable: false, defaultValue: "0", isPrimaryKey: false, references: null },
      { name: "status", type: "character varying", nullable: false, defaultValue: "'pending'", isPrimaryKey: false, references: null },
      { name: "created_at", type: "timestamp with time zone", nullable: false, defaultValue: "now()", isPrimaryKey: false, references: null },
    ],
  },
  {
    name: "order_items",
    estimatedRows: 24190,
    columns: [
      { name: "id", type: "uuid", nullable: false, defaultValue: "gen_random_uuid()", isPrimaryKey: true, references: null },
      { name: "order_id", type: "uuid", nullable: false, defaultValue: null, isPrimaryKey: false, references: { table: "orders", column: "id" } },
      { name: "product_id", type: "uuid", nullable: false, defaultValue: null, isPrimaryKey: false, references: { table: "products", column: "id" } },
      { name: "quantity", type: "integer", nullable: false, defaultValue: "1", isPrimaryKey: false, references: null },
      { name: "unit_price", type: "numeric", nullable: false, defaultValue: null, isPrimaryKey: false, references: null },
    ],
  },
  {
    name: "products",
    estimatedRows: 450,
    columns: [
      { name: "id", type: "uuid", nullable: false, defaultValue: "gen_random_uuid()", isPrimaryKey: true, references: null },
      { name: "sku", type: "character varying", nullable: false, defaultValue: null, isPrimaryKey: false, references: null },
      { name: "title", type: "character varying", nullable: false, defaultValue: null, isPrimaryKey: false, references: null },
      { name: "price", type: "numeric", nullable: false, defaultValue: "0.00", isPrimaryKey: false, references: null },
      { name: "stock_count", type: "integer", nullable: false, defaultValue: "0", isPrimaryKey: false, references: null },
    ],
  },
];

export async function inspectDatabaseSchema(): Promise<SchemaInspectionResult> {
  const nodes = getNodes();
  const primary = nodes.find((n) => n.role === "primary");

  if (databaseConfig.simulate || !primary) {
    return {
      databaseName: primary ? primary.id : "simulated_cluster",
      serverVersion: "PostgreSQL 16.2 (Simulated)",
      isSimulated: true,
      hasConnectedPrimary: Boolean(primary),
      tables: SAMPLE_SIMULATED_TABLES,
      totalTables: SAMPLE_SIMULATED_TABLES.length,
      totalEstimatedRows: SAMPLE_SIMULATED_TABLES.reduce((acc, t) => acc + t.estimatedRows, 0),
      inspectedAt: nowIso(),
    };
  }

  try {
    // 1. Database name and server version
    const metaRes = await runOnNode(primary.id, "SELECT current_database() as db, version() as ver");
    const dbName = String(metaRes.rows[0]?.["db"] ?? "postgres");
    const ver = String(metaRes.rows[0]?.["ver"] ?? "").split(" on ")[0] ?? "PostgreSQL";

    // 2. Fetch all user tables & estimated row counts
    const tablesSql = `
      SELECT 
        t.table_name,
        COALESCE(s.n_live_tup, 0) AS estimated_rows
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name
      WHERE t.table_schema = 'public' 
        AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name ASC;
    `;
    const tablesRes = await runOnNode(primary.id, tablesSql);

    // 3. Fetch all columns
    const columnsSql = `
      SELECT 
        table_name,
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name ASC, ordinal_position ASC;
    `;
    const columnsRes = await runOnNode(primary.id, columnsSql);

    // 4. Fetch Primary Keys and Foreign Keys
    const constraintsSql = `
      SELECT
        tc.table_name,
        kcu.column_name,
        tc.constraint_type,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY');
    `;
    const constraintsRes = await runOnNode(primary.id, constraintsSql);

    // Build lookup maps
    const pkSet = new Set<string>(); // "table.column"
    const fkMap = new Map<string, { table: string; column: string }>(); // "table.column" -> { table, column }

    for (const row of constraintsRes.rows) {
      const tbl = String(row["table_name"] ?? "");
      const col = String(row["column_name"] ?? "");
      const type = String(row["constraint_type"] ?? "");
      const key = `${tbl}.${col}`;

      if (type === "PRIMARY KEY") {
        pkSet.add(key);
      } else if (type === "FOREIGN KEY") {
        const foreignTable = String(row["foreign_table_name"] ?? "");
        const foreignCol = String(row["foreign_column_name"] ?? "");
        if (foreignTable && foreignCol) {
          fkMap.set(key, { table: foreignTable, column: foreignCol });
        }
      }
    }

    // Group columns by table
    const tableColumns = new Map<string, ColumnDetail[]>();
    for (const col of columnsRes.rows) {
      const tbl = String(col["table_name"] ?? "");
      const colName = String(col["column_name"] ?? "");
      const key = `${tbl}.${colName}`;

      const detail: ColumnDetail = {
        name: colName,
        type: String(col["data_type"] ?? "text"),
        nullable: String(col["is_nullable"] ?? "").toUpperCase() === "YES",
        defaultValue: col["column_default"] ? String(col["column_default"]) : null,
        isPrimaryKey: pkSet.has(key),
        references: fkMap.get(key) ?? null,
      };

      if (!tableColumns.has(tbl)) {
        tableColumns.set(tbl, []);
      }
      tableColumns.get(tbl)!.push(detail);
    }

    const tables: TableDetail[] = tablesRes.rows.map((r) => {
      const name = String(r["table_name"]);
      return {
        name,
        estimatedRows: Number(r["estimated_rows"] ?? 0),
        columns: tableColumns.get(name) ?? [],
      };
    });

    return {
      databaseName: dbName,
      serverVersion: ver,
      isSimulated: false,
      hasConnectedPrimary: true,
      tables,
      totalTables: tables.length,
      totalEstimatedRows: tables.reduce((acc, t) => acc + t.estimatedRows, 0),
      inspectedAt: nowIso(),
    };
  } catch (error) {
    logger.warn("Live schema inspection failed, falling back to simulated structure", {
      error: String(error),
    });
    return {
      databaseName: primary.id,
      serverVersion: "PostgreSQL",
      isSimulated: true,
      hasConnectedPrimary: true,
      tables: SAMPLE_SIMULATED_TABLES,
      totalTables: SAMPLE_SIMULATED_TABLES.length,
      totalEstimatedRows: SAMPLE_SIMULATED_TABLES.reduce((acc, t) => acc + t.estimatedRows, 0),
      inspectedAt: nowIso(),
    };
  }
}

export async function seedDemoTables(): Promise<{ success: boolean; message: string }> {
  const nodes = getNodes();
  const primary = nodes.find((n) => n.role === "primary");

  if (!primary || databaseConfig.simulate) {
    return { success: true, message: "Demo tables are already active in simulation mode." };
  }

  const ddl = `
    CREATE TABLE IF NOT EXISTS app_users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE,
      display_name text NOT NULL,
      role text NOT NULL DEFAULT 'viewer',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      avatar_url text,
      preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      total_cents integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'completed',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_name text NOT NULL,
      quantity integer NOT NULL DEFAULT 1,
      unit_price numeric(10,2) NOT NULL DEFAULT 0.00
    );

    -- Insert seed demo rows if app_users is empty
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM app_users LIMIT 1) THEN
        INSERT INTO app_users (id, email, display_name, role) VALUES
          ('11111111-1111-1111-1111-111111111111', 'operator@pg-router.ai', 'Cluster Operator', 'admin'),
          ('22222222-2222-2222-2222-222222222222', 'developer@pg-router.ai', 'Lead Engineer', 'developer'),
          ('33333333-3333-3333-3333-333333333333', 'analyst@pg-router.ai', 'Data Analyst', 'viewer');

        INSERT INTO profiles (user_id, avatar_url, preferences) VALUES
          ('11111111-1111-1111-1111-111111111111', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100', '{"theme": "dark", "notifications": true}'::jsonb),
          ('22222222-2222-2222-2222-222222222222', null, '{"theme": "system"}'::jsonb);

        INSERT INTO orders (id, user_id, total_cents, status) VALUES
          ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 4900, 'completed'),
          ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', 12900, 'processing');

        INSERT INTO order_items (order_id, product_name, quantity, unit_price) VALUES
          ('44444444-4444-4444-4444-444444444444', 'PostgreSQL High Availability Pro', 1, 49.00),
          ('55555555-5555-5555-5555-555555555555', 'Observability Enterprise Tier', 1, 129.00);
      END IF;
    END $$;
  `;

  await runOnNode(primary.id, ddl);
  return { success: true, message: "Sample tables and records created successfully on the primary database." };
}
