import { describe, expect, it } from "vitest";
import { signInitDataForTest, verifyInitData } from "./telegram-auth.js";

const TOKEN = "123456:test-bot-token";

function freshInitData(userId = 42): string {
  const now = Math.floor(Date.now() / 1000);
  return signInitDataForTest(TOKEN, {
    auth_date: String(now),
    query_id: "AAA",
    user: JSON.stringify({ id: userId, first_name: "T", username: "t" }),
  });
}

describe("verifyInitData", () => {
  it("accepts a correctly-signed payload and extracts the user", () => {
    const r = verifyInitData(freshInitData(7), TOKEN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.user.id).toBe(7);
  });

  it("rejects a tampered payload", () => {
    const good = freshInitData(7);
    const tampered = good.replace("first_name%22%3A%22T", "first_name%22%3A%22X"); // flip a byte
    const r = verifyInitData(tampered, TOKEN);
    expect(r.ok).toBe(false);
  });

  it("rejects the wrong bot token", () => {
    expect(verifyInitData(freshInitData(), "999:other").ok).toBe(false);
  });

  it("rejects missing/empty initData", () => {
    expect(verifyInitData("", TOKEN).ok).toBe(false);
  });

  it("rejects stale initData when maxAge is set", () => {
    const old = signInitDataForTest(TOKEN, {
      auth_date: String(Math.floor(Date.now() / 1000) - 100000),
      user: JSON.stringify({ id: 1 }),
    });
    expect(verifyInitData(old, TOKEN, 3600).ok).toBe(false);
  });
});
