import { assertSafeSql } from "../src/utils/validators";

describe("validators", () => {
  it("accepts a single parameterized statement", () => {
    expect(() => assertSafeSql("SELECT * FROM users WHERE id = $1")).not.toThrow();
  });

  it("rejects stacked statements", () => {
    expect(() => assertSafeSql("SELECT 1; DROP TABLE users")).toThrow();
  });

  it("rejects known injection patterns", () => {
    expect(() => assertSafeSql("SELECT * FROM users WHERE 1=1 OR 1=1")).toThrow();
    expect(() => assertSafeSql("SELECT pg_sleep(10)")).toThrow();
  });
});
