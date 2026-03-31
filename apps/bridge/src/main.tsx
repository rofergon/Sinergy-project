import React from "react";
import ReactDOM from "react-dom/client";
import { Buffer } from "buffer";
import "@initia/interwovenkit-react/styles.css";
import App from "./App";
import { Providers } from "./providers";

(globalThis as any).Buffer = Buffer;
(globalThis as any).process ??= { env: {} };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Providers>
      <App />
    </Providers>
  </React.StrictMode>
);
