import { issueRefresh, rotateRefresh, signAccessToken, verifyAccessToken } from "../src/auth/tokens";

describe("authentication tokens", () => {
  it("issues a short-lived signed access token", () => {
    const payload = verifyAccessToken(signAccessToken("user-1", "viewer"));
    expect(payload.sub).toBe("user-1");
    expect(payload.role).toBe("viewer");
    expect(payload.type).toBe("access");
  });

  it("rotates refresh tokens and rejects reuse", async () => {
    const first = await issueRefresh("user-2");
    const second = await rotateRefresh(first.raw);
    expect(second.userId).toBe("user-2");
    expect(second.raw).not.toBe(first.raw);
    await expect(rotateRefresh(first.raw)).rejects.toThrow("reuse");
  });
});