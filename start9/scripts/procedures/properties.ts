// Start9 properties procedure
// Returns dynamic properties displayed in the service UI

export const properties = async (effects: any) => {
	const result: Record<string, unknown> = {}

	try {
		const response = await effects.fetch('http://localhost:3000', {
			headers: { Accept: 'application/nostr+json' },
		})

		if (response.status === 200) {
			const info = JSON.parse(await response.text())
			result['Relay Name'] = {
				type: 'string',
				value: info.name ?? 'unknown',
				description: 'The public name of this relay',
				copyable: false,
			}
			result['Supported NIPs'] = {
				type: 'string',
				value: (info.supported_nips ?? []).join(', '),
				description: 'Nostr Implementation Possibilities supported by this relay',
				copyable: false,
			}
			result['Version'] = {
				type: 'string',
				value: info.version ?? 'unknown',
				description: 'nostr-swarm version',
				copyable: false,
			}
		}
	} catch {
		// Service not running yet
	}

	return result
}
