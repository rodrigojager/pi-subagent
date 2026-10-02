import { describe, expect, test } from "bun:test";
import { generateSubagentInstanceName } from "../src/shared/instance-name.js";

describe("generateSubagentInstanceName", () => {
  test("generates numbered execution labels", () => {
    const name = generateSubagentInstanceName();
    expect(name).toMatch(/^#[1-9]\d*$/);
  });
});
