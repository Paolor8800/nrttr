import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        display: ["Unbounded", "sans-serif"],
        body: ["Inter", "system-ui", "sans-serif"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        hp: {
          DEFAULT: "hsl(var(--hp-bar))",
          low: "hsl(var(--hp-bar-low))",
        },
        accent: "hsl(var(--accent-glow))",
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "card-enter": {
          from: { opacity: "0", transform: "translateY(20px) scale(0.95)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "card-exit": {
          from: { opacity: "1", transform: "scale(1)" },
          to: { opacity: "0", transform: "scale(0.9) translateY(-10px)" },
        },
        "accent-shake": {
          "0%, 100%": { transform: "translateX(0) rotate(0deg)" },
          "10%": { transform: "translateX(-8px) rotate(-2deg)" },
          "20%": { transform: "translateX(8px) rotate(2deg)" },
          "30%": { transform: "translateX(-6px) rotate(-1deg)" },
          "40%": { transform: "translateX(6px) rotate(1deg)" },
          "50%": { transform: "translateX(-4px) rotate(0deg)" },
          "60%": { transform: "translateX(4px) rotate(0deg)" },
          "70%": { transform: "translateX(-2px)" },
          "80%": { transform: "translateX(2px)" },
          "90%": { transform: "translateX(-1px)" },
        },
        "accent-zoom": {
          "0%": { opacity: "0", transform: "scale(0.3)" },
          "50%": { opacity: "1", transform: "scale(1.1)" },
          "70%": { transform: "scale(0.95)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "pulse-red": {
          "0%, 100%": { boxShadow: "0 0 0 0 hsl(0 72% 42% / 0)" },
          "50%": { boxShadow: "0 0 20px 5px hsl(0 72% 42% / 0.4)" },
        },
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(16px)", filter: "blur(4px)" },
          to: { opacity: "1", transform: "translateY(0)", filter: "blur(0)" },
        },
        "hp-decrease": {
          "0%": { backgroundColor: "hsl(0 80% 50%)" },
          "50%": { backgroundColor: "hsl(0 90% 60%)" },
          "100%": { backgroundColor: "hsl(0 80% 50%)" },
        },
        "float": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "card-enter": "card-enter 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "card-exit": "card-exit 0.3s ease-in forwards",
        "accent-shake": "accent-shake 0.8s ease-in-out",
        "accent-zoom": "accent-zoom 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "pulse-red": "pulse-red 2s ease-in-out infinite",
        "fade-in-up": "fade-in-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "hp-decrease": "hp-decrease 0.6s ease-in-out",
        "float": "float 3s ease-in-out infinite",
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
