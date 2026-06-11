// Start9 properties procedure
// Returns dynamic properties displayed in the service UI

interface Effects {
	fetch(
		url: string,
		opts?: { headers?: Record<string, string> },
	): Promise<{ status: number; text(): Promise<string> }>
	readFile(opts: { volumeId: string; path: string }): Promise<string>
}

export const properties = async (effects: Effects) => {
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
			result.Version = {
				type: 'string',
				value: info.version ?? 'unknown',
				description: 'nostr-swarm version',
				copyable: false,
			}
		}
	} catch {
		// Service not running yet
	}

	// Node identity written by the relay at startup (STORAGE_PATH is
	// /data/nostr-swarm-data; the 'main' volume mounts /data).
	try {
		const raw = await effects.readFile({
			volumeId: 'main',
			path: 'nostr-swarm-data/keys.json',
		})
		const keys = JSON.parse(raw)
		if (typeof keys.invite === 'string' && keys.invite.length > 0) {
			result['Relay Invite'] = {
				type: 'string',
				value: keys.invite,
				description:
					"Share this invite with other operators: they paste it into their Bootstrap Key (Invite) config field to join this relay's shared event store",
				copyable: true,
			}
		}
		if (typeof keys.writerKey === 'string' && keys.writerKey.length > 0) {
			result['Local Writer Key'] = {
				type: 'string',
				value: keys.writerKey,
				description:
					"This node's writer key. To get write access on a shared event store, send it to an existing writer's operator — they add it to their Admit Writers config field",
				copyable: true,
			}
		}
	} catch {
		// keys.json not written yet (first start still initializing); degrade gracefully
	}

	return result
}
