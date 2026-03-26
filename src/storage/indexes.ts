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
	}
}
