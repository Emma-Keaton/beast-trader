/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0fdfa", 100: "#ccfbf1", 200: "#99f6e4", 300: "#5eead4",
          400: "#2dd4bf", 500: "#14b8a6", 600: "#0d9488", 700: "#0f766e",
          800: "#115e59", 900: "#134e4a", 950: "#042f2e",
        },
        bull: "#22c55e",
        bear: "#ef4444",
        alpha: "#f59e0b",
        plasma: "#8b5cf6",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["'Space Grotesk'", "Inter", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
      },
      borderRadius: { card: "1rem", control: "0.625rem" },
      boxShadow: {
        card: "0 1px 2px 0 rgb(2 6 23 / 0.06), 0 4px 16px -4px rgb(2 6 23 / 0.10)",
        "card-hover": "0 2px 4px 0 rgb(2 6 23 / 0.08), 0 12px 28px -8px rgb(2 6 23 / 0.18)",
      },
      maxWidth: { shell: "1400px" },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "soft-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.45s cubic-bezier(0.16,1,0.3,1) both",
        "soft-pulse": "soft-pulse 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
