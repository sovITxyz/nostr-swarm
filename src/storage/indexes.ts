import type Hyperbee from 'hyperbee'

/** Names of all sub-databases used for indexing */
export const SUB_NAMES = {
	events: 'events',
	kind: 'kind',
	author: 'author',
	authorKind: 'author_kind',
	tag: 'tag',
	createdAt: 'created_at',
	replaceable: 'replaceable',
	addressable: 'addressable',
	expiration: 'expiration',
	deletion: 'deletion',
	writers: 'writers',
	config: 'config',
} as const

export interface IndexSubs {
	events: Hyperbee
	kind: Hyperbee
	author: Hyperbee
	authorKind: Hyperbee
	tag: Hyperbee
	createdAt: Hyperbee
	replaceable: Hyperbee
	addressable: Hyperbee
	expiration: Hyperbee
	deletion: Hyperbee
	/**
	 * Admitted writers: key = writerKeyHex (64 lowercase hex), value = { addedBy }.
	 * The founder's own writer key is implicit and never recorded here.
	 */
	writers: Hyperbee
	/**
	 * Base-wide consensus config: key = flag name, value = boolean. Written only
	 * by founder-authored set_config ops; read by apply() to gate behavior
	 * deterministically (e.g. 'accept_optimistic').
	 */
	config: Hyperbee
}

/** Create all sub-databases from a root Hyperbee */
export function createSubs(db: Hyperbee): IndexSubs {
	const opts = { keyEncoding: 'utf-8', valueEncoding: 'json' }
	return {
		events: db.sub(SUB_NAMES.events, opts),
		kind: db.sub(SUB_NAMES.kind, opts),
		author: db.sub(SUB_NAMES.author, opts),
		authorKind: db.sub(SUB_NAMES.authorKind, opts),
		tag: db.sub(SUB_NAMES.tag, opts),
		createdAt: db.sub(SUB_NAMES.createdAt, opts),
		replaceable: db.sub(SUB_NAMES.replaceable, opts),
		addressable: db.sub(SUB_NAMES.addressable, opts),
		expiration: db.sub(SUB_NAMES.expiration, opts),
		deletion: db.sub(SUB_NAMES.deletion, opts),
		writers: db.sub(SUB_NAMES.writers, opts),
		config: db.sub(SUB_NAMES.config, opts),
	}
}
