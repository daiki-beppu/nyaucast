import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "unit",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
