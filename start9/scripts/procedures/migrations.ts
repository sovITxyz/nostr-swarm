// Start9 migration procedures
// Handle data migrations between versions

interface Effects {
	readFile(opts: { volumeId: string; path: string }): Promise<string>
	writeFile(opts: { volumeId: string; path: string; toWrite: string }): Promise<void>
}

const CONFIG_PATH = 'start9/config.yaml'

// Config keys introduced in 0.2.0 (multi-writer sync). Upgrades inject them
// as null (empty) defaults so the config form round-trips cleanly. There is
// NO data transform: existing installs keep their event store untouched —
// the relay records its own base key into <storage>/bootstrap-key and
// keys.json on first post-upgrade start (recording identity, not changing it).
const KEYS_ADDED_0_2_0 = ['bootstrap-key', 'admit-writers']

/** True when `version` (e.g. '0.1.0') is older than [major, minor, patch] */
function olderThan(version: string, target: [number, number, number]): boolean {
	const parts = version.split('.').map((p) => Number.parseInt(p, 10))
	const major = Number.isFinite(parts[0]) ? (parts[0] as number) : 0
	const minor = Number.isFinite(parts[1]) ? (parts[1] as number) : 0
	const patch = Number.isFinite(parts[2]) ? (parts[2] as number) : 0
	if (major !== target[0]) return major < target[0]
	if (minor !== target[1]) return minor < target[1]
	return patch < target[2]
}

export const migration = async (effects: Effects, version: string, direction: string) => {
	if (direction === 'from' && olderThan(version, [0, 2, 0])) {
		// Upgrading from pre-0.2.0: add the new multi-writer keys with empty
		// (null) values. Empty values are ignored by both getConfig defaults
		// and docker_entrypoint.sh, so behavior is unchanged until the
		// operator fills them in.
		try {
			const raw = await effects.readFile({ volumeId: 'main', path: CONFIG_PATH })
			let content = raw.endsWith('\n') || raw === '' ? raw : `${raw}\n`
			let changed = false
			for (const key of KEYS_ADDED_0_2_0) {
				const present = content.split('\n').some((line) => line.startsWith(`${key}:`))
				if (!present) {
					content += `${key}:\n`
					changed = true
				}
			}
			if (changed) {
				await effects.writeFile({ volumeId: 'main', path: CONFIG_PATH, toWrite: content })
			}
		} catch {
			// No config file yet — getConfig defaults already cover the new keys
		}
	}
	// Downgrades ('to'): leave config untouched; older versions ignore the
	// extra keys and the storage layout only gained bootstrap-key/keys.json.
	return { configured: true }
}
