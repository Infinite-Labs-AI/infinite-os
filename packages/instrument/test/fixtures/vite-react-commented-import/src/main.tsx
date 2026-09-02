import { setup } from "./setup";

// The only react-dom import is COMMENTED OUT — it must not bind `createRoot`:
// import { createRoot } from "react-dom/client";

// A local function that merely shares the name. Matching the bare name would wire the wrong file.
function createRoot(value: number): number {
  return value + 1;
}

setup(createRoot(1));
