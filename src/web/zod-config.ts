import { z } from "zod";

// The page's Content-Security-Policy allows no eval. zod's fast object parser is built with
// Function, and zod tries `new Function("")` to see whether it may, which the browser reports as
// a refused eval. With jitless, zod never tries. This module runs before any module that makes a
// schema, since zod reads the setting when each object schema is made.
z.config({ jitless: true });
