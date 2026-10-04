import { loadInfiniteOsConfig } from "@infinite-os/config";
import { runMigrations } from "./index.js";

const config = loadInfiniteOsConfig();
const applied = await runMigrations(config.databaseUrl);

if (applied.length === 0) {
  console.log("Infinite OS migrations already up to date.");
} else {
  console.log(`Applied Infinite OS migrations: ${applied.join(", ")}`);
}
