import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native Node.js module — exclude it from Webpack bundling
  // so it can load its compiled binary at runtime.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
