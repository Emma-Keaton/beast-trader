import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { CurrencyProvider } from "./lib/CurrencyContext";
import "./index.css";

/**
 * Splash screen.
 *
 * The background is the exact colour sampled from the `logo_w_text` master
 * (#050D1F), so the app appears to fade up out of the launcher icon rather
 * than snapping between two shades. The logo itself is the generated
 * `/og-image.jpg` art rather than a re-drawn wordmark, so there is only ever
 * one source of truth for the brand.
 */
function Splash() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // Hide once the app has painted, and never leave the user stuck on it.
    const t = setTimeout(() => setHidden(true), 1100);
    return () => clearTimeout(t);
  }, []);

  if (hidden) return null;
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center transition-opacity duration-500"
      style={{ backgroundColor: "rgb(var(--brand-dark))" }}
      role="status"
      aria-label="Loading Beast-Trader"
    >
      <img
        src="/og-image.jpg"
        alt="Beast-Trader"
        className="w-[78vw] max-w-sm animate-fade-up"
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <CurrencyProvider>
        <Splash />
        <App />
      </CurrencyProvider>
    </BrowserRouter>
  </StrictMode>,
);
