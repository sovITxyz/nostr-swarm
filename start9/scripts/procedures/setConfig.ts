// Start9 setConfig procedure
// Writes config values to a YAML file in the data volume

export const setConfig = async (effects: any, input: Record<string, unknown>) => {
	const lines: string[] = []

	for (const [key, value] of Object.entries(input)) {
		if (value !== null && value !== undefined && value !== '') {
			lines.push(`${key}: ${value}`)
		}
	}

	const yaml = lines.join('\n') + '\n'

	await effects.writeFile({
		volumeId: 'main',
		path: 'start9/config.yaml',
		toWrite: yaml,
	})

	return { signal: 'SIGTERM', 'depends-on': {} }
}
