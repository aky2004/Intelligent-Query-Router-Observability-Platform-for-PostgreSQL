import { Parser } from "node-sql-parser";
import type { ParsedQuery, QueryType } from "../types/query";
import { QueryError } from "../utils/errors";

const parser = new Parser();
const OPTS = { database: "PostgresQL" } as const;

const TRANSACTION_RE = /^\s*(begin|start\s+transaction|commit|rollback|savepoint|release\s+savepoint)\b/i;
const DDL_RE = /^\s*(create|alter|drop|truncate|grant|revoke|vacuum|analyze|reindex)\b/i;

/** Strips literals and collapses whitespace so equivalent queries share one shape. */
export const normalizeQuery = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(\.\d+)?\b/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const detectTypeFromText = (sql: string): QueryType => {
  if (TRANSACTION_RE.test(sql)) return "TRANSACTION";
  if (DDL_RE.test(sql)) return "DDL";
  const first = sql.trim().split(/\s+/)[0]?.toUpperCase();
  switch (first) {
    case "SELECT":
    case "WITH":
    case "EXPLAIN":
    case "SHOW":
      return "SELECT";
    case "INSERT":
      return "INSERT";
    case "UPDATE":
      return "UPDATE";
    case "DELETE":
      return "DELETE";
    default:
      return "UNKNOWN";
  }
};

export const isWriteQuery = (sql: string): boolean => {
  const type = detectTypeFromText(sql);
  if (type === "INSERT" || type === "UPDATE" || type === "DELETE" || type === "DDL") return true;
  // SELECT ... FOR UPDATE / data-modifying CTEs must go to the primary.
  if (/\bfor\s+(update|no\s+key\s+update|share)\b/i.test(sql)) return true;
  if (/\bwith\b[\s\S]*\b(insert|update|delete)\b/i.test(sql)) return true;
  return false;
};

export const extractTables = (sql: string): string[] => {
  try {
    const list = parser.tableList(sql, OPTS);
    const tables = list
      .map((entry) => entry.split("::").pop() ?? "")
      .filter((name) => name && name !== "null");
    return [...new Set(tables)];
  } catch {
    const matches = sql.matchAll(/\b(?:from|join|into|update)\s+["']?([a-zA-Z_][\w.$]*)["']?/gi);
    return [...new Set([...matches].map((m) => m[1].toLowerCase()))];
  }
};

/** Rough 0-100 complexity score, used to decide whether AI analysis is worthwhile. */
export const scoreComplexity = (sql: string, tables: string[]): number => {
  const lower = sql.toLowerCase();
  let score = Math.min(20, tables.length * 5);
  score += (lower.match(/\bjoin\b/g)?.length ?? 0) * 8;
  score += Math.max(0, (lower.match(/\bselect\b/g)?.length ?? 1) - 1) * 10; // subqueries
  score += /\bgroup\s+by\b/.test(lower) ? 6 : 0;
  score += /\border\s+by\b/.test(lower) ? 4 : 0;
  score += /\bdistinct\b/.test(lower) ? 4 : 0;
  score += /\bunion\b/.test(lower) ? 8 : 0;
  score += /\bwith\b/.test(lower) ? 6 : 0;
  score += /\bover\s*\(/.test(lower) ? 8 : 0;
  score += /\blike\s+'%/.test(lower) ? 6 : 0;
  score += lower.length > 500 ? 6 : 0;
  return Math.max(1, Math.min(100, Math.round(score)));
};

export const parseQuery = (sql: string): ParsedQuery => {
  if (!sql?.trim()) throw new QueryError("Cannot parse an empty query");

  let ast: unknown = null;
  try {
    ast = parser.astify(sql, OPTS);
  } catch (error) {
    // Transaction control and some PG-specific syntax are not in the grammar.
    if (!TRANSACTION_RE.test(sql) && !DDL_RE.test(sql)) {
      ast = null;
    }
    void error;
  }

  const type = detectTypeFromText(sql);
  const tables = type === "TRANSACTION" ? [] : extractTables(sql);

  return {
    sql,
    normalized: normalizeQuery(sql),
    type,
    tables,
    isWrite: isWriteQuery(sql),
    complexity: scoreComplexity(sql, tables),
    ast,
  };
};
