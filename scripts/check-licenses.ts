import { checkLicenses, listInstalled, readReviewed } from "./licenses.ts";

const shipped = listInstalled("prod");
const buildTime = listInstalled("dev");
if (shipped.length === 0 || buildTime.length === 0) {
  console.error("pnpm listed no packages. Run pnpm install first.");
  process.exit(1);
}

const problems = checkLicenses({ shipped, buildTime, reviewed: readReviewed() });
if (problems.length > 0) {
  console.error(`The license check failed for ${problems.length} package(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `The license check passed: ${shipped.length} shipped and ${buildTime.length} build-time packages.`,
);
