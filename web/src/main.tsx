import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installShortcuts, syncSelection } from "./actions";
import { connect } from "./api";
import { toast } from "./store";
import { engine } from "./engine";
import "./styles.css";

installShortcuts();
syncSelection();
connect().catch((err) => toast(`Can't reach the cutroom server: ${err.message}`, "error"));
// Redraw captions once a web font finishes loading (system fonts are already available).
window.addEventListener("cutroom:font", () => engine.refresh());
document.fonts?.addEventListener?.("loadingdone", () => engine.refresh());
createRoot(document.getElementById("root")!).render(<App />);
