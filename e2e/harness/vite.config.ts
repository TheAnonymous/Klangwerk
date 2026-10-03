import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The CSP of musik.jodie-oesterling.de: the engine has to work under it (Blob worker and worklet).
export const CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob: data:; worker-src 'self' blob:; manifest-src 'self'";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: { headers: { "Content-Security-Policy": CSP }, fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
});
