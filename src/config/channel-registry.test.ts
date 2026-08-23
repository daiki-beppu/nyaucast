import { describe, expect, test } from "bun:test";

import { channelRegistrySchema } from "./channel-registry";

describe("channel registry schema", () => {
  test("accepts an empty list and absolute channel repository paths", () => {
    const paths = ["/channels/soulful-grooves", "/channels/deepfocus365"];

    expect(channelRegistrySchema.parse([])).toEqual([]);
    expect(channelRegistrySchema.parse(paths)).toEqual(paths);
  });

  test.each([
    ["a relative path", ["channels/soulful-grooves"]],
    ["metadata objects", [{ path: "/channels/soulful-grooves" }]],
    ["an object wrapper", { channels: ["/channels/soulful-grooves"] }],
    ["a scalar", "/channels/soulful-grooves"],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(() => channelRegistrySchema.parse(value)).toThrow();
  });
});
