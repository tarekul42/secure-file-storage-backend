import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 30000,
    env: {
      NODE_ENV: "test",
      PORT: "4100",
      DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5434/secure_file_storage_test",
      JWT_SECRET: "test-only-secret-at-least-16-chars",
      S3_ENDPOINT: "http://localhost:9000",
      AWS_FORCE_PATH_STYLE: "true",
      AWS_REGION: "us-east-1",
      AWS_S3_BUCKET_NAME: "secure-files",
      AWS_ACCESS_KEY_ID: "minioadmin",
      AWS_SECRET_ACCESS_KEY: "minioadmin",
      FRONTEND_ORIGIN: "http://localhost:3000",
      ALLOWED_CONTENT_TYPES:
        "application/octet-stream,text/plain,image/png,application/json,application/pdf",
    },
    include: ["tests/**/*.test.ts"],
  },
});
