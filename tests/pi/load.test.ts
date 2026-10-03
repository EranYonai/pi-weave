import { expect, it, vi } from "vitest";

// Browser dependencies are bundled into app.js and absent from npm installs.
vi.mock("d3-force", () => {
  throw new Error("Cannot find module 'd3-force'");
});

it("loads the Pi extension without d3-force installed", async () => {
  const extension = await import("../../src/pi/index");
  expect(extension.default).toBeTypeOf("function");
});
