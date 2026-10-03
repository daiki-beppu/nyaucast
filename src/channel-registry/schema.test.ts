import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { accepts } from "../../test/helpers.ts";
import { channelRegistrySchema } from "./schema.ts";

describe("channel registry schema", () => {
  it("accepts a JSON array of absolute channel paths", () => {
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(channelRegistrySchema)([
        "/channels/soulful-grooves",
        "/channels/deepfocus365",
      ]),
      ["/channels/soulful-grooves", "/channels/deepfocus365"],
    );
  });

  it.each([
    ["relative path", ["channels/soulful-grooves"]],
    ["metadata object", [{ path: "/channels/soulful-grooves" }]],
    ["display name entry", [{ name: "Soulful Grooves", path: "/channels/soulful-grooves" }]],
  ])("rejects a %s", (_label, value) => {
    assert.isFalse(accepts(channelRegistrySchema, value));
  });
});
