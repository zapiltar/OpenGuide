import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            OWNER_EMAILS: "owner@example.com",
            DEV_ADMIN_EMAIL: "owner@example.com",
            SETUP_CODE: "test-setup-code-123",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.js"] },
  };
});
