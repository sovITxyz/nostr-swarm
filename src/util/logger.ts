type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let minLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel): void {
	minLevel = level
}

function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
	if (LEVELS[level] < LEVELS[minLevel]) return
	const ts = new Date().toISOString()
	const line = data ? `${ts} [${level.toUpperCase()}] ${msg} ${JSON.stringify(data)}` : `${ts} [${level.toUpperCase()}] ${msg}`
	if (level === 'error') {
		console.error(line)
	} else if (level === 'warn') {
		console.warn(line)
	} else {
		console.log(line)
	}
}

export const logger = {
	debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
	info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
	warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
	error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
}
