import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Build output directory, overridable per process.
   *
   * `next build` and `next dev` both own `.next` exclusively, so running a
   * build while `pnpm dev` is up replaces the running server's chunks under
   * it and wedges it with 404s and `__webpack_modules__ is not a function`
   * until it is restarted. Setting NEXT_DIST_DIR gives a second Next process
   * -- a production build, or a throwaway dev server on another port -- its
   * own directory so the two cannot collide.
   */
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
