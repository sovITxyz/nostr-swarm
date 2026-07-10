import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
	version: string
}

export default defineConfig({
	entry: ['src/index.ts', 'src/cli.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	sourcemap: true,
	target: 'node20',
	define: {
		__PKG_VERSION__: JSON.stringify(pkg.version),
	},
})
