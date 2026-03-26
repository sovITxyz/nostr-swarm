declare module 'autobase' {
	import type { EventEmitter } from 'node:events'

	interface AutobaseOptions {
		open: (store: any) => any
		apply: (nodes: any[], view: any, host: any) => Promise<void>
		valueEncoding?: string
		ackInterval?: number
		encryptionKey?: Buffer | Promise<Buffer>
		encrypt?: boolean
		fastForward?: boolean
		bigBatches?: boolean
	}

	class Autobase extends EventEmitter {
		constructor(store: any, bootstrap: Buffer | null, opts: AutobaseOptions)
		key: Buffer | null
		discoveryKey: Buffer | null
		view: any
		core: any
		local: { key: Buffer }
		length: number
		writable: boolean
		isIndexer: boolean
		ready(): Promise<void>
		close(): Promise<void>
		append(value: any, opts?: any): Promise<void>
		update(): Promise<void>
		ack(bg?: boolean): Promise<void>
	}

	export default Autobase
}

declare module 'hyperbee' {
	interface HyperbeeOptions {
		keyEncoding?: string
		valueEncoding?: string
		readonly?: boolean
		metadata?: any
	}

	interface HyperbeeEntry {
		seq: number
		key: string
		value: any
	}

	class Hyperbee {
		constructor(core: any, opts?: HyperbeeOptions)
		core: any
		key: Buffer
		discoveryKey: Buffer
		version: number
		writable: boolean
		readable: boolean
		ready(): Promise<void>
		close(): Promise<void>
		put(key: string, value?: any, opts?: any): Promise<void>
		get(key: string, opts?: any): Promise<HyperbeeEntry | null>
		del(key: string, opts?: any): Promise<void>
		batch(opts?: any): Hyperbee
		flush(): Promise<void>
		sub(prefix: string, opts?: any): Hyperbee
		createReadStream(range?: any, opts?: any): AsyncIterable<HyperbeeEntry>
		createHistoryStream(opts?: any): AsyncIterable<any>
		peek(range?: any, opts?: any): Promise<HyperbeeEntry | null>
	}

	export default Hyperbee
}

declare module 'corestore' {
	class Corestore {
		constructor(storage: string, opts?: any)
		ready(): Promise<void>
		close(): Promise<void>
		get(opts: any): any
		replicate(stream: any): any
	}

	export default Corestore
}

declare module 'hyperswarm' {
	import type { EventEmitter } from 'node:events'

	interface SwarmOptions {
		keyPair?: any
		seed?: Buffer
	}

	interface PeerInfo {
		publicKey: Buffer
		topics: Buffer[]
	}

	class Hyperswarm extends EventEmitter {
		constructor(opts?: SwarmOptions)
		join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): {
			flushed(): Promise<void>
		}
		leave(topic: Buffer): Promise<void>
		destroy(): Promise<void>
		connections: Set<any>
	}

	export default Hyperswarm
}

declare module 'graceful-goodbye' {
	function goodbye(fn: () => Promise<void> | void, priority?: number): void
	export default goodbye
}

declare module 'b4a' {
	export function from(input: string | Buffer, encoding?: string): Buffer
	export function toString(buf: Buffer, encoding?: string): string
	export function alloc(size: number, fill?: number): Buffer
	export function isBuffer(obj: any): obj is Buffer
}
