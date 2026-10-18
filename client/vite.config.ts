import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react()],
	// in dev, /api (including the sync websocket) goes to the Node server in server/server.ts
	server: { proxy: { '/api': { target: 'http://localhost:5858', ws: true } } },
})
