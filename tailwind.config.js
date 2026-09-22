/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0c0d12",
        surface: "#12141c",
        elevated: "#181b26",
        panel: "#1e2230",
        border: "#2a3040",
        fg: "#eef2f7",
        muted: "#8b93a7",
        subtle: "#5c6578",
        accent: "#4fc3f7",
        "accent-fg": "#071018",
        success: "#3dd68c",
        danger: "#ff6b7a",
      },
    },
  },
};
