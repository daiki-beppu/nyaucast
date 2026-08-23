import path from "node:path";

import { z } from "zod";

export const channelRegistrySchema = z.array(
  z.string().refine((value) => path.isAbsolute(value), {
    message: "channel repository paths must be absolute",
  })
);
