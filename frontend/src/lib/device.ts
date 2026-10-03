/** Persistent device identity (no signup). Technique adapted from jasper-trades deviceFingerprint. */
const DEVICE_KEY = "beast_device_id";

export function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().replace(/-/g, "").slice(0, 32)
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function resetDeviceId(): void {
  localStorage.removeItem(DEVICE_KEY);
}
