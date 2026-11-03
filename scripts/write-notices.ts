import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listInstalled, ROOT, readReviewed } from "./licenses.ts";
import { noticesFor, renderNotices } from "./notices.ts";

// The image's notices cover the production tree, which is all the image's node_modules holds.
const IMAGE_NOTICES = "dist/THIRD-PARTY-NOTICES.txt";

const shipped = listInstalled("prod");
if (shipped.length === 0) {
  console.error("pnpm listed no production packages. Run pnpm install first.");
  process.exit(1);
}
const { notices, problems } = noticesFor(shipped, readReviewed());
if (problems.length > 0) {
  console.error(`Could not write ${IMAGE_NOTICES}:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
mkdirSync(join(ROOT, "dist"), { recursive: true });
writeFileSync(
  join(ROOT, IMAGE_NOTICES),
  renderNotices("Third-party notices for the Family Finance Tracker image", notices),
);
console.log(`Wrote ${IMAGE_NOTICES} for ${notices.length} production packages.`);
