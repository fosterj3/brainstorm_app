import { describe, expect, it } from "vitest";
import { defaultDbPath } from "./db";

const only = (...present: string[]) => (p: string) => present.includes(p);

describe("defaultDbPath", () => {
  it("uses DB_PATH when it is set", () => {
    expect(defaultDbPath("/data/custom.db", only("data/ority.db", "data/brainstorm.db"))).toBe("/data/custom.db");
  });

  it("uses the Ority filename for a fresh install", () => {
    expect(defaultDbPath(undefined, only())).toBe("data/ority.db");
  });

  it("keeps using the old filename when only that file exists, so no boards are orphaned", () => {
    expect(defaultDbPath(undefined, only("data/brainstorm.db"))).toBe("data/brainstorm.db");
  });

  it("prefers the Ority file once it exists", () => {
    expect(defaultDbPath(undefined, only("data/ority.db", "data/brainstorm.db"))).toBe("data/ority.db");
  });
});
