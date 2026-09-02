import { setup } from "./setup";

// The react-dom import below lives INSIDE a multiline template literal — it is documentation text,
// not a real import, and must never bind `createRoot`.
const sample = `
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")).render(<App />);
`;

// A local function that merely shares the name. Matching the bare name would wire the wrong file.
function createRoot(value: number): { render: () => void } {
  return { render: () => setup(value) };
}

console.log(sample);
createRoot(1).render();
