import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /*
   * The workspace root, which is the repository root and not this folder.
   *
   * This app is the `web` workspace of the repository above it, so npm hoists `next` itself to
   * `<repo>/node_modules` and leaves only the packages it cannot hoist here. Turbopack resolves
   * modules within the root it is given: pointed at this folder, it stops one level below the
   * only copy of `next` there is, and fails with "Could not find the Next.js package
   * (next/package.json) — filesystem root used for resolution: …\web". That is what happened on
   * a second machine whose install hoisted a little differently from the one this was written
   * on. Pointing it at the repository root covers both layouts, because a package hoisted to
   * the root and one kept here are then both inside it.
   */
  turbopack: { root: dirname(dirname(fileURLToPath(import.meta.url))) },
  // The API is a separate local process; the browser talks to it directly (CORS is enabled
  // there for this origin), so no rewrites are needed.
};

export default nextConfig;
