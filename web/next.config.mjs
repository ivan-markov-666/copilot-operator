import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This app lives inside an npm workspace. Without an explicit root, Turbopack picks the
  // repository root from the lockfile and then resolves `next` relative to the wrong folder.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  // The API is a separate local process; the browser talks to it directly (CORS is enabled
  // there for this origin), so no rewrites are needed.
};

export default nextConfig;
