// Type declarations for native artifacts imported as files (bun build --compile
// embeds them; the spike's compile-entry.ts dlopens the embedded copy).
declare module "*.so" {
  const path: string;
  export default path;
}
