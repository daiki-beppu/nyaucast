import { isAbsolute } from "node:path";

import { Schema } from "effect";

const AbsolutePath = Schema.String.check(
  Schema.makeFilter((path) => isAbsolute(path) || "channel paths must be absolute"),
);

export const channelRegistrySchema = Schema.Array(AbsolutePath);
