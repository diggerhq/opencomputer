import { defineConfig } from 'vite'
import { holocron } from '@holocron.so/vite'

export default defineConfig({
  clearScreen: false,
  plugins: [holocron({ pagesDir: '.', configPath: './docs.jsonc' })],
})
