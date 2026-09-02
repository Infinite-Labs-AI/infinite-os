import React from "react";
import { createRoot } from "react-dom/client";

function App(): React.JSX.Element {
  return <h1>Vite fixture</h1>;
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

createRoot(root).render(<App />);
