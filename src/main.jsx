import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import LineupSolver from "./LineupSolver.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <LineupSolver />
  </StrictMode>
);
