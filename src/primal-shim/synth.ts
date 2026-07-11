/**
 * Encoders for Primal's synthetic cache-protocol events.
 *
 * These are not valid Nostr events and are never signed: the Primal web app's
 * parsers switch on `kind` and read `content` (plus `pubkey`/`tags` for a few
 * kinds), so id/sig stay empty. Kind numbers and content schemas mirror
 * primal-web-app src/constants.ts (v3.0.101) and primal-server src/app.jl.
 */

import type { NostrEvent } from '../util/types.js'

export const PRIMAL_KIND = {
	/** Generic ack; the client never checks this kind, only reads content when it expects one */
	ack: 10000098,
	eventStats: 10000100,
	netStats: 10000101,
	defaultSettings: 10000103,
	userStats: 10000105,
	referencedEvent: 10000107,
	userScores: 10000108,
	notification: 10000110,
	seenUntil: 10000111,
	notificationSummary: 10000112,
	feedRange: 10000113,
	noteActions: 10000115,
	directMsgCount: 10000117,
	mediaInfo: 10000119,
	defaultRelays: 10000124,
	isUserFollowing: 10000125,
	importResponse: 10000127,
	followerCounts: 10000133,
	userRelays: 10000139,
	broadcastResponse: 10000149,
	readsFeeds: 10000152,
	homeFeeds: 10000153,
} as const

/** Wire shape for synthetic events: a NostrEvent-shaped object with empty id/sig */
export function synthEvent(kind: number, content: string, extra?: Partial<NostrEvent>): NostrEvent {
	return {
		id: '',
		pubkey: '',
		created_at: Math.floor(Date.now() / 1000),
		kind,
		tags: [],
		content,
		sig: '',
		...extra,
	}
}

export interface EventStats {
	event_id: string
	likes: number
	replies: number
	mentions: number
	reposts: number
	zaps: number
	satszapped: number
	score: number
	score24h: number
	bookmarks: number
}

export function emptyStats(eventId: string): EventStats {
	return {
		event_id: eventId,
		likes: 0,
		replies: 0,
		mentions: 0,
		reposts: 0,
		zaps: 0,
		satszapped: 0,
		score: 0,
		score24h: 0,
		bookmarks: 0,
	}
}

export function encodeEventStats(stats: EventStats): NostrEvent {
	return synthEvent(PRIMAL_KIND.eventStats, JSON.stringify(stats))
}

export interface UserStats {
	pubkey: string
	follows_count: number
	followers_count: number
	note_count: number
	reply_count: number
	time_joined: number
	relay_count: number
	total_zap_count: number
	total_satszapped: number
	media_count: number
	long_form_note_count: number
}

export function encodeUserStats(pubkey: string, fields?: Partial<UserStats>): NostrEvent {
	const stats: UserStats = {
		pubkey,
		follows_count: 0,
		followers_count: 0,
		note_count: 0,
		reply_count: 0,
		time_joined: 0,
		relay_count: 0,
		total_zap_count: 0,
		total_satszapped: 0,
		media_count: 0,
		long_form_note_count: 0,
		...fields,
	}
	return synthEvent(PRIMAL_KIND.userStats, JSON.stringify(stats), { pubkey })
}

/** Referenced/quoted event: content is the JSON-stringified full original event */
export function encodeReferencedEvent(event: NostrEvent): NostrEvent {
	return synthEvent(PRIMAL_KIND.referencedEvent, JSON.stringify(event), { pubkey: event.pubkey })
}

export function encodeUserScores(scores: Record<string, number>): NostrEvent {
	return synthEvent(PRIMAL_KIND.userScores, JSON.stringify(scores))
}

export function encodeNotification(notification: Record<string, unknown>): NostrEvent {
	return synthEvent(PRIMAL_KIND.notification, JSON.stringify(notification))
}

export function encodeSeenUntil(ts: number): NostrEvent {
	return synthEvent(PRIMAL_KIND.seenUntil, String(ts))
}

/**
 * Notification badge summary. Deliberately NOT a NostrEvent: the client sums
 * every top-level field except `pubkey` and `kind` into the badge count, so
 * id/created_at/sig/tags/content must all be absent.
 */
export function encodeNotificationSummary(
	pubkey: string,
	countsByType: Record<string, number>,
): Record<string, unknown> {
	return { kind: PRIMAL_KIND.notificationSummary, pubkey, ...countsByType }
}

/**
 * Feed page range (mandatory on every feed/search response — without it the
 * client renders an empty page). Elements are event ids in feed order.
 */
export function encodeFeedRange(events: Array<{ id: string; created_at: number }>): NostrEvent {
	const times = events.map((e) => e.created_at)
	const range = {
		since: times.length > 0 ? Math.min(...times) : 0,
		until: times.length > 0 ? Math.max(...times) : 0,
		order_by: 'created_at',
		elements: events.map((e) => e.id),
	}
	return synthEvent(PRIMAL_KIND.feedRange, JSON.stringify(range))
}

export interface NoteActions {
	event_id: string
	replied: boolean
	liked: boolean
	reposted: boolean
	zapped: boolean
}

export function encodeNoteActions(actions: NoteActions): NostrEvent {
	return synthEvent(PRIMAL_KIND.noteActions, JSON.stringify(actions))
}

export function encodeDefaultRelays(urls: string[]): NostrEvent {
	return synthEvent(PRIMAL_KIND.defaultRelays, JSON.stringify(urls))
}

export function encodeIsUserFollowing(following: boolean): NostrEvent {
	return synthEvent(PRIMAL_KIND.isUserFollowing, following ? 'true' : 'false')
}

export function encodeImportResponse(imported: number, errors: number): NostrEvent {
	return synthEvent(PRIMAL_KIND.importResponse, JSON.stringify({ imported, errors }))
}

export function encodeFollowerCounts(counts: Record<string, number>): NostrEvent {
	return synthEvent(PRIMAL_KIND.followerCounts, JSON.stringify(counts))
}

/** User relay list: the client reads `tags` ("r" entries), not content */
export function encodeUserRelays(pubkey: string, urls: string[]): NostrEvent {
	return synthEvent(PRIMAL_KIND.userRelays, '', {
		pubkey,
		tags: urls.map((url) => ['r', url]),
	})
}

/** broadcast_events ack: any EVENT before EOSE means success to the client */
export function encodeBroadcastResponse(
	results: Array<{ event_id: string; accepted: boolean; reason: string }>,
): NostrEvent {
	const content = results.map((r) => ({
		event_id: r.event_id,
		responses: [[r.accepted ? 'ok' : r.reason]],
	}))
	return synthEvent(PRIMAL_KIND.broadcastResponse, JSON.stringify(content))
}

/**
 * Default app settings blob. SettingsContext's loadDefaults reads
 * `feeds`/`notifications`/`notificationsAdditional` with bare Object.keys and
 * assigns `zapDefault`/`zapConfig` unconditionally, so all five must be
 * present and well-formed. Values mirror primal-web-app src/constants.ts.
 */
export const DEFAULT_APP_SETTINGS = {
	description: 'Default Primal-Web App settings (nostr-swarm primal-shim)',
	theme: 'sunset',
	feeds: [],
	zapDefault: { amount: 42, message: 'Onward 🫡' },
	zapConfig: [
		{ emoji: '👍', amount: 21, message: 'Great post 👍' },
		{ emoji: '🚀', amount: 420, message: "Let's go 🚀" },
		{ emoji: '☕', amount: 1000, message: 'Coffee on me ☕' },
		{ emoji: '🍻', amount: 5000, message: 'Cheers 🍻' },
		{ emoji: '🍷', amount: 10000, message: 'Party time 🍷' },
		{ emoji: '👑', amount: 100000, message: 'Generational wealth 👑' },
	],
	defaultZapAmount: 42,
	zapOptions: [21, 420, 1000, 5000, 10000, 100000],
	notifications: {
		NEW_USER_FOLLOWED_YOU: true,
		USER_UNFOLLOWED_YOU: true,
		YOUR_POST_WAS_ZAPPED: true,
		YOUR_POST_WAS_LIKED: true,
		YOUR_POST_WAS_REPOSTED: true,
		YOUR_POST_WAS_REPLIED_TO: true,
		YOU_WERE_MENTIONED_IN_POST: true,
		YOUR_POST_WAS_MENTIONED_IN_POST: true,
		POST_YOU_WERE_MENTIONED_IN_WAS_ZAPPED: true,
		POST_YOU_WERE_MENTIONED_IN_WAS_LIKED: true,
		POST_YOU_WERE_MENTIONED_IN_WAS_REPOSTED: true,
		POST_YOU_WERE_MENTIONED_IN_WAS_REPLIED_TO: true,
		POST_YOUR_POST_WAS_MENTIONED_IN_WAS_ZAPPED: true,
		POST_YOUR_POST_WAS_MENTIONED_IN_WAS_LIKED: true,
		POST_YOUR_POST_WAS_MENTIONED_IN_WAS_REPOSTED: true,
		POST_YOUR_POST_WAS_MENTIONED_IN_WAS_REPLIED_TO: true,
		LIVE_EVENT_HAPPENING: true,
	},
	notificationsAdditional: {
		ignore_events_with_too_many_mentions: true,
	},
	applyContentModeration: false,
	contentModeration: [],
	proxyThroughPrimal: false,
}

/** The d-tag namespace every Primal settings event uses */
export const SETTINGS_APP = 'Primal-Web App'

/** Nostr kind of the (real, user-signed) app-settings event */
export const KIND_APP_SETTINGS = 30078

export function encodeDefaultAppSettings(): NostrEvent {
	return synthEvent(PRIMAL_KIND.defaultSettings, JSON.stringify(DEFAULT_APP_SETTINGS), {
		tags: [['d', SETTINGS_APP]],
	})
}

/** Defaults materialized as the user's own settings event (kind 30078, unsigned) */
export function encodeUserAppSettings(pubkey: string, content?: string): NostrEvent {
	return synthEvent(KIND_APP_SETTINGS, content ?? JSON.stringify(DEFAULT_APP_SETTINGS), {
		pubkey,
		tags: [['d', SETTINGS_APP]],
	})
}

export interface FeedDefinition {
	name: string
	spec: string
	description: string
	enabled: boolean
	feedkind: string
}

/**
 * The shim-defined feed catalog. Spec strings form a closed loop with
 * verbs/feeds.ts — every spec advertised here must be honored there.
 */
export const DEFAULT_HOME_FEEDS: FeedDefinition[] = [
	{
		name: 'Latest',
		spec: '{"id":"latest","kind":"notes"}',
		description: 'Latest notes from accounts you follow',
		enabled: true,
		feedkind: 'notes',
	},
	{
		name: 'All Notes',
		spec: '{"id":"all-notes","kind":"notes"}',
		description: 'Every note on this relay, newest first',
		enabled: true,
		feedkind: 'notes',
	},
]

export const DEFAULT_READS_FEEDS: FeedDefinition[] = [
	{
		name: 'All Reads',
		spec: '{"id":"all-reads","kind":"reads"}',
		description: 'Long-form articles on this relay, newest first',
		enabled: true,
		feedkind: 'reads',
	},
]

export function encodeFeedsList(kind: number, feeds: FeedDefinition[]): NostrEvent {
	return synthEvent(kind, JSON.stringify(feeds))
}
