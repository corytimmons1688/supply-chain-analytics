// MUST stay first: patches window.fetch before anything captures a reference
// to it. Dev-only, gated on VITE_MOCK_API — see src/mocks/mock-api.ts.
import "./mocks/install";

import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
