declare module 'autobase' {
	// biome-ignore lint/correctness/noUnusedImports: used by `class Autobase extends EventEmitter`
	import type { EventEmitter } from 'node:events'

	/** A linearized input node handed to apply() (autobase/lib/apply-state.js applyBatch entries) */
	export interface AutobaseApplyNode {
		/** The appended op payload; null for ack nodes */
		value: any
		/** The writer hypercore that authored this node */
		from: { key: Buffer }
		length: number
		heads: { key: Buffer; length: number }[]
		/**
		 * True for blocks applied via the optimistic path (a non-writer's
		 * speculative append). v1 never accepts these — apply() skips them so
		 * autobase rolls the block back. See store.ts apply().
		 */
		optimistic?: boolean
	}

	/** Host calls available to apply() (autobase/lib/apply-calls.js PrivateApplyCalls) */
	export interface AutobaseApplyHost {
		/** The base key (= the founder's local writer key) */
		key: Buffer
		discoveryKey: Buffer
		addWriter(key: Buffer, opts?: { indexer?: boolean }): Promise<void>
		ackWriter(key: Buffer): Promise<void>
		removeWriter(key: Buffer): Promise<void>
		interrupt(reason?: string): void
	}

	interface AutobaseOptions {
		open: (store: any) => any
		apply: (nodes: AutobaseApplyNode[], view: any, host: AutobaseApplyHost) => Promise<void>
		valueEncoding?: string
		ackInterval?: number
		/** Enable the optimistic-apply path for non-writer appends (constructor-gated consensus option) */
		optimistic?: boolean
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
		/** The local input core (its key is this node's writer key); null before ready() */
		local: { key: Buffer; length: number }
		length: number
		writable: boolean
		isIndexer: boolean
		ready(): Promise<void>
		close(): Promise<void>
		append(value: any, opts?: any): Promise<void>
		update(): Promise<void>
		ack(bg?: boolean): Promise<void>
		/** Replicate the underlying corestore + protomux wakeup over a stream/socket */
		replicate(stream: any, opts?: any): any
		waitForWritable(): Promise<boolean>
		/** 'writable'/'unwritable' fire on writability transitions; 'update' after each drain */
		on(event: 'writable' | 'unwritable' | 'update' | 'is-indexer', listener: () => void): this
		on(event: string | symbol, listener: (...args: any[]) => void): this
		once(event: 'writable' | 'unwritable' | 'update' | 'is-indexer', listener: () => void): this
		once(event: string | symbol, listener: (...args: any[]) => void): this
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
	// biome-ignore lint/correctness/noUnusedImports: used by `class Hyperswarm extends EventEmitter`
	import type { EventEmitter } from 'node:events'

	interface SwarmOptions {
		keyPair?: any
		seed?: Buffer
		/** DHT bootstrap node list (e.g. a local hyperdht testnet); defaults to the public DHT */
		bootstrap?: { host: string; port: number }[]
	}

	export interface PeerInfo {
		publicKey: Buffer
		topics: Buffer[]
	}

	/** Encrypted Noise connection socket handed to 'connection' listeners */
	export interface SwarmSocket {
		remotePublicKey: Buffer
		/**
		 * The Noise handshake transcript hash (from @hyperswarm/secret-stream),
		 * identical on both peers and unique per connection; null until the
		 * handshake completes (it is populated by the time 'connection' fires).
		 * Bound into the v2 admission proof to make it replay-proof.
		 */
		handshakeHash: Buffer | null
		on(event: 'close', listener: () => void): SwarmSocket
		on(event: 'error', listener: (err: Error) => void): SwarmSocket
		write(data: Buffer | string): boolean
		destroy(err?: Error): void
	}

	class Hyperswarm extends EventEmitter {
		constructor(opts?: SwarmOptions)
		join(
			topic: Buffer,
			opts?: { server?: boolean; client?: boolean },
		): {
			flushed(): Promise<void>
		}
		leave(topic: Buffer): Promise<void>
		destroy(): Promise<void>
		connections: Set<any>
	}

	export default Hyperswarm
}

// The '/testnet.js' subpath is mandatory: hyperdht has no exports map.
declare module 'hyperdht/testnet.js' {
	interface TestnetNode {
		destroy(): Promise<void>
	}

	class Testnet {
		nodes: TestnetNode[]
		bootstrap: { host: string; port: number }[]
		createNode(opts?: object): unknown
		destroy(): Promise<void>
	}

	type Teardown = (fn: () => Promise<void>, opts?: { order?: number }) => void

	function createTestnet(
		size?: number,
		opts?: { host?: string; port?: number; teardown?: Teardown } | Teardown,
	): Promise<Testnet>

	export default createTestnet
}

declare module 'graceful-goodbye' {
	function goodbye(fn: () => Promise<void> | void, priority?: number): void
	export default goodbye
}

declare module 'protomux' {
	/** A registered message type on a channel (protomux index.js Message) */
	interface ProtomuxMessage<T = any> {
		send(data: T): boolean
		encoding: any
		onmessage: (message: T) => void
	}

	/** A protocol channel multiplexed over the shared stream */
	interface ProtomuxChannel {
		addMessage<T = any>(opts: {
			encoding?: any
			onmessage?: (message: T) => void
		}): ProtomuxMessage<T>
		open(handshake?: any): void
		close(): void
		cork(): void
		uncork(): void
		readonly closed: boolean
	}

	class Protomux {
		constructor(stream: any, opts?: any)
		/** Accept either an existing muxer or a stream (creating/returning its muxer) */
		static from(stream: any, opts?: any): Protomux
		/** Returns null for a duplicate (unique) channel or one the remote already closed */
		createChannel(opts: {
			protocol: string
			id?: Buffer | null
			unique?: boolean
			handshake?: any
			messages?: any[]
			userData?: any
			onopen?: (handshake?: any) => void
			onclose?: () => void
			ondestroy?: () => void
			ondrain?: () => void
		}): ProtomuxChannel | null
		opened(opts: { protocol: string; id?: Buffer | null }): boolean
	}

	export default Protomux
}

declare module 'compact-encoding' {
	export interface Encoding<T = any> {
		preencode(state: any, value: T): void
		encode(state: any, value: T): void
		decode(state: any): T
	}
	export const json: Encoding
	export const string: Encoding<string>
	export const raw: Encoding<Buffer>
	export const buffer: Encoding<Buffer>
	export const bool: Encoding<boolean>
	export function encode<T>(enc: Encoding<T>, value: T): Buffer
	export function decode<T>(enc: Encoding<T>, buffer: Buffer): T
	const c: {
		json: Encoding
		string: Encoding<string>
		raw: Encoding<Buffer>
		buffer: Encoding<Buffer>
		bool: Encoding<boolean>
		encode: typeof encode
		decode: typeof decode
	}
	export default c
}

declare module 'b4a' {
	export function from(input: string | Buffer, encoding?: string): Buffer
	// biome-ignore lint/suspicious/noShadowRestrictedNames: b4a really exports `toString`
	export function toString(buf: Buffer, encoding?: string): string
	export function alloc(size: number, fill?: number): Buffer
	export function isBuffer(obj: any): obj is Buffer
}
