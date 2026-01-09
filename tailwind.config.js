import typography from '@tailwindcss/typography';
import containerQueries from '@tailwindcss/container-queries';

/** @type {import('tailwindcss').Config} */
export default {
	darkMode: 'class',
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {
			colors: {
				primary: {
          light: "#A8D0F0",   // azul claro (hover / bg)
          DEFAULT: "#2E86C1", // azul principal
          dark: "#1B4F72"     // azul profundo (header/hover)
        },
        gray: {
          light: "#F5F6F7",   // bg claro
          DEFAULT: "#D0D3D4", // cinza médio
          dark: "#6E6F70",    // texto / bordas
					850: "#1F2933",
        },
        success: {
          light: "#A9DFBF",
          DEFAULT: "#27AE60",
          dark: "#1E8449"
        },
        danger: {
          light: "#F5B7B1",
          DEFAULT: "#CB4335",
          dark: "#922B21"
        },
        info: {
          light: "#AED6F1",
          DEFAULT: "#5DADE2",
          dark: "#2E86C1"
        },
        background: {
          light: "#F9FAFB",
          DEFAULT: "#F2F3F4",
          dark: "#E5E7E9"
        }
			},
			typography: {
				DEFAULT: {
					css: {
						pre: false,
						code: false,
						'pre code': false,
						'code::before': false,
						'code::after': false
					}
				}
			},
			padding: {
				'safe-bottom': 'env(safe-area-inset-bottom)'
			},
			transitionProperty: {
				width: 'width'
			}
		}
	},
	plugins: [typography, containerQueries]
};
