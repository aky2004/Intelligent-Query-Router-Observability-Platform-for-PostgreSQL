import {
  applyControlStatement,
  commit,
  getState,
  isInTransaction,
  rollback,
  startTransaction,
} from "../src/router/transaction-state";

describe("transaction state machine", () => {
  it("tracks begin and commit", () => {
    startTransaction("s1");
    expect(isInTransaction("s1")).toBe(true);
    commit("s1");
    expect(isInTransaction("s1")).toBe(false);
  });

  it("tracks savepoints via control statements", () => {
    applyControlStatement("s2", "BEGIN");
    applyControlStatement("s2", "SAVEPOINT sp1");
    expect(getState("s2").savepoints).toEqual(["sp1"]);
    applyControlStatement("s2", "ROLLBACK TO SAVEPOINT sp1");
    expect(getState("s2").savepoints).toEqual([]);
    rollback("s2");
    expect(isInTransaction("s2")).toBe(false);
  });
});
