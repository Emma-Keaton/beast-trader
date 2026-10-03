import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ToastProvider } from "./components/Toast";
import { LogoSync } from "./components/ui";
import { api, type DeviceSettings } from "./lib/api";
import { shortAddr } from "./lib/format";
import Dashboard from "./pages/Dashboard";
import Markets from "./pages/Markets";
import Watchlist from "./pages/Watchlist";
import Signals from "./pages/Signals";
import SettingsPage from "./pages/Settings";
import ProposalsPage from "./pages/Proposals";

export default function App() {
  const [settings, setSettings] = useState<DeviceSettings | null>(null);

  useEffect(() => {
    api.settings().then(setSettings).catch(() => setSettings({}));
  }, []);

  const walletLabel = settings?.wallet_address
    ? `${shortAddr(settings.wallet_address)} · ${settings.wallet_chain || "evm"}`
    : undefined;

  return (
    <ToastProvider>
      <LogoSync />
      <Layout walletLabel={walletLabel}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/markets" element={<Markets />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/signals" element={<Signals />} />
          <Route path="/proposals" element={<ProposalsPage />} />
          <Route path="/settings" element={<SettingsPage onSaved={setSettings} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </ToastProvider>
  );
}
