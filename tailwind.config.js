/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Roboto', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Allied Bank brand palette (light institutional theme)
        navy: '#0A3B85',
        azure: '#1E63D6',
        orange: '#F37021',
        ink: '#14233F',
        paper: '#F4F6FA',
        rule: '#DCE3EE',
        steel: '#5A6A82',
        ok: '#059669',
        breach: '#DC2626',
      },
      borderRadius: { DEFAULT: '2px', sm: '2px', md: '3px', lg: '3px' },
    },
  },
  plugins: [],
}