import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { cx } from "./ui";

type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const ToastCtx = createContext<(kind: ToastKind, message: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++seq;
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "pointer-events-auto flex w-full max-w-sm animate-fade-up items-center gap-2 rounded-card border px-4 py-3 text-sm shadow-card",
              t.kind === "success" && "border-green-600/30 bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200",
              t.kind === "error" && "border-red-600/30 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200",
              t.kind === "info" && "border-slate-300 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200",
            )}
          >
            {t.kind === "success" && <CheckCircle2 className="h-4 w-4 shrink-0" />}
            {t.kind === "error" && <AlertTriangle className="h-4 w-4 shrink-0" />}
            {t.kind === "info" && <Info className="h-4 w-4 shrink-0" />}
            <span className="flex-1">{t.message}</span>
            <button type="button" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <X className="h-3.5 w-3.5 opacity-60" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
