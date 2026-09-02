import { isAbsolute } from "node:path";

import { z } from "zod";

export const channelRegistrySchema = z.array(
  z.string().refine((path) => isAbsolute(path), "channel paths must be absolute"),
);
