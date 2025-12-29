import type { Config } from "tailwindcss";
import defaultTheme from "tailwindcss/defaultTheme";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", ...defaultTheme.fontFamily.sans]
      },
      colors: {
        border: "hsl(214, 17%, 92%)",
        muted: "hsl(215, 16%, 47%)",
        background: "hsl(0, 0%, 100%)",
        foreground: "hsl(222, 47%, 11%)"
      }
    }
  },
  plugins: [require("tailwindcss-animate")]
};

export default config;
