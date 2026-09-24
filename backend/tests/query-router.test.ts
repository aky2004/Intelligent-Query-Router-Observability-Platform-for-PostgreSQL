process.env.SIMULATE_DB = "true";

import { executeQuery, routeQuery } from "../src/router/query-router";
import { commit, startTransaction } from "../src/router/transaction-state";

describe("query router", () => {
  it("sends reads to a replica", () => {
    const decision = routeQuery("SELECT * FROM users LIMIT 5", { sessionId: "r1" });
    expect(decision.target).toBe("replica");
  });

  it("sends writes to the primary", () => {
    const decision = routeQuery("UPDATE users SET email = $1 WHERE id = $2", { sessionId: "r2" });
    expect(decision.target).toBe("primary");
  });

  it("pins a session with an open transaction to the primary", () => {
    startTransaction("r3");
    expect(routeQuery("SELECT 1", { sessionId: "r3" }).target).toBe("primary");
    commit("r3");
  });

  it("executes against the simulated node", async () => {
    const { result, decision } = await executeQuery("SELECT * FROM users LIMIT 3", [], { sessionId: "r4" });
    expect(result.rowCount).toBeGreaterThan(0);
    expect(decision.nodeId).toBeTruthy();
  });
});
