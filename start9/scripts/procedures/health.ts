// Start9 health check procedure
// Verifies the WebSocket server is alive by attempting a connection

export const health = async (effects: any) => {
	try {
		const result = await effects.fetch('http://localhost:3000', {
			headers: { Accept: 'application/nostr+json' },
		})

		if (result.status === 200) {
			return { result: 'success' }
		}

		return {
			result: 'failure',
			message: `HTTP ${result.status}`,
		}
	} catch (err: any) {
		return {
			result: 'failure',
			message: err.message ?? 'Connection failed',
		}
	}
}
