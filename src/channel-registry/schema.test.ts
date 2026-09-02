import { describe, expect, test } from "vite-plus/test";

import { channelRegistrySchema } from "./schema";

describe("channel registry schema", () => {
  test("accepts a JSON array of absolute channel paths", () => {
    expect(
      channelRegistrySchema.parse(["/channels/soulful-grooves", "/channels/deepfocus365"]),
    ).toEqual(["/channels/soulful-grooves", "/channels/deepfocus365"]);
  });

  test.each([
    ["relative path", ["channels/soulful-grooves"]],
    ["metadata object", [{ path: "/channels/soulful-grooves" }]],
    ["display name entry", [{ name: "Soulful Grooves", path: "/channels/soulful-grooves" }]],
  ])("rejects a %s", (_label, value) => {
    expect(() => channelRegistrySchema.parse(value)).toThrow();
  });
});
