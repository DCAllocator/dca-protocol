import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Two dev servers from one checkout (e.g. `pnpm dev` and `pnpm dev:test-vault`) must not share .next:
  // NEXT_DIST_DIR=.next-test-vault pnpm dev:test-vault
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  env: {
    // Dev flag for the local test vault: `SHOW_TEST_VAULT=1 pnpm dev` is the same as NEXT_PUBLIC_SHOW_TEST_VAULT=1.
    NEXT_PUBLIC_SHOW_TEST_VAULT: process.env.NEXT_PUBLIC_SHOW_TEST_VAULT ?? process.env.SHOW_TEST_VAULT ?? "",
  },
  webpack: (config) => {
    // Optional / server-only deps pulled in transitively by wallet connectors (never used in the browser bundle).
    config.externals.push("pino-pretty", "lokijs", "encoding");
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/core/client": false,
      "@x402/evm": false,
      "@x402/evm/exact/client": false,
      "@x402/evm/upto/client": false,
      "@x402/svm/exact/client": false,
      "@react-native-async-storage/async-storage": false,
    };
    return config;
  },
};

export default nextConfig;
