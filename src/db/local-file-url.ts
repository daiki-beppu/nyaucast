import { pathToFileURL } from "node:url";

export const localFileUrl = (filePath: string): string =>
  pathToFileURL(filePath).href;
