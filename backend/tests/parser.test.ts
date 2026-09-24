import { extractTables, isWriteQuery, normalizeQuery, parseQuery, scoreComplexity } from "../src/router/parser";

describe("parser", () => {
  it("classifies reads and writes", () => {
    expect(isWriteQuery("SELECT * FROM users")).toBe(false);
    expect(isWriteQuery("INSERT INTO users (email) VALUES ($1)")).toBe(true);
    expect(isWriteQuery("SELECT * FROM users FOR UPDATE")).toBe(true);
    expect(isWriteQuery("WITH moved AS (DELETE FROM a RETURNING *) SELECT * FROM moved")).toBe(true);
  });

  it("extracts referenced tables", () => {
    expect(extractTables("SELECT * FROM users JOIN orders ON orders.user_id = users.id").sort()).toEqual([
      "orders",
      "users",
    ]);
  });

  it("normalizes literals to a stable shape", () => {
    expect(normalizeQuery("SELECT * FROM users WHERE id = 42")).toBe(
      normalizeQuery("select * from users where id = 99"),
    );
  });

  it("scores complex queries higher", () => {
    const simple = scoreComplexity("SELECT id FROM users", ["users"]);
    const complex = scoreComplexity(
      "SELECT DISTINCT u.id FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.id ORDER BY u.id",
      ["users", "orders"],
    );
    expect(complex).toBeGreaterThan(simple);
  });

  it("parses a select into the expected shape", () => {
    const parsed = parseQuery("SELECT id FROM users WHERE id = 1");
    expect(parsed.type).toBe("SELECT");
    expect(parsed.isWrite).toBe(false);
    expect(parsed.tables).toContain("users");
  });
});
