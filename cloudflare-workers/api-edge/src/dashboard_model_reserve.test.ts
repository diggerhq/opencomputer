import { describe, expect, it } from "vitest";
import { managedModelReserveCents } from "./dashboard";

describe("managedModelReserveCents", () => {
  it("defaults to $1.00 of headroom held back from the spendable balance", () => {
    expect(managedModelReserveCents({})).toBe(100);
    expect(managedModelReserveCents({ MANAGED_MODEL_RESERVE_USD: "" })).toBe(100);
    expect(managedModelReserveCents({ MANAGED_MODEL_RESERVE_USD: "abc" })).toBe(100);
    expect(managedModelReserveCents({ MANAGED_MODEL_RESERVE_USD: "-1" })).toBe(100);
  });

  it("honours a configured reserve, including zero", () => {
    expect(managedModelReserveCents({ MANAGED_MODEL_RESERVE_USD: "0.5" })).toBe(50);
    expect(managedModelReserveCents({ MANAGED_MODEL_RESERVE_USD: " 2 " })).toBe(200);
    expect(managedModelReserveCents({ MANAGED_MODEL_RESERVE_USD: "0" })).toBe(0);
  });
});
