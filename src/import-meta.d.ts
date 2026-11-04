// What Vite puts in import.meta.env for the server code. Under `pnpm dev` and the tests, DEV is
// true; the build replaces it with false. Plain Node, as in scripts/, has no import.meta.env.
interface ImportMeta {
  readonly env?: { readonly DEV: boolean };
}
