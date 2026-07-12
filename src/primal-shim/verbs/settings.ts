/**
 * Boot/settings verbs: protocol handshake, app settings, feed catalogs,
 * relay lists, releases.
 */

import type { VerbContext, VerbHandler } from '../handler.js'
import { requireHex64, requireUserEvent } from '../handler.js'
import {
	DEFAULT_HOME_FEEDS,
	DEFAULT_READS_FEEDS,
	KIND_APP_SETTINGS,
	PRIMAL_KIND,
	SETTINGS_APP,
	encodeDefaultAppSettings,
	encodeDefaultRelays,
	encodeFeedsList,
	encodeUserAppSettings,
	encodeUserRelays,
	synthEvent,
} from '../synth.js'

/**
 * Compression/batching handshake sent first on every socket. The client only
 * waits for EOSE and handles plain text frames regardless of the negotiated
 * compression, so acknowledging without implementing zlib is safe.
 */
// biome-ignore lint/correctness/useYield: an empty response IS the ack — EOSE follows
export const setPrimalProtocol: VerbHandler = async function* () {}

export const getDefaultAppSettings: VerbHandler = async function* () {
	yield encodeDefaultAppSettings()
}

export const getAppSettings: VerbHandler = async function* (payload, ctx) {
	const user = requireUserEvent(payload)
	const stored = await ctx.relay.fetch([
		{ kinds: [KIND_APP_SETTINGS], authors: [user.pubkey], '#d': [SETTINGS_APP], limit: 1 },
	])
	if (stored.length > 0) yield stored[0]
	else yield encodeUserAppSettings(user.pubkey)
}

export const setAppSettings: VerbHandler = async function* (payload, ctx) {
	const settingsEvent = requireUserEvent(payload)
	if (settingsEvent.kind !== KIND_APP_SETTINGS) {
		throw new Error('settings event must be kind 30078')
	}
	const result = await ctx.relay.publish(settingsEvent)
	if (!result.accepted && !result.reason.startsWith('duplicate:')) {
		throw new Error(`settings not stored: ${result.reason}`)
	}
	yield settingsEvent
}

/**
 * Subsettings share the settings event's d-tag namespace, so persisting them
 * to the relay would clobber the main settings event. Answering with bare
 * EOSE makes the client fall back to get_home_feeds / built-in defaults.
 */
// biome-ignore lint/correctness/useYield: deliberate empty response (client falls back)
export const getAppSubsettings: VerbHandler = async function* (payload) {
	requireUserEvent(payload)
}

// biome-ignore lint/correctness/useYield: subsettings are not persisted in the MVP
export const setAppSubsettings: VerbHandler = async function* (payload) {
	requireUserEvent(payload)
}

export const getHomeFeeds: VerbHandler = async function* () {
	yield encodeFeedsList(PRIMAL_KIND.homeFeeds, DEFAULT_HOME_FEEDS)
}

export const getReadsFeeds: VerbHandler = async function* () {
	yield encodeFeedsList(PRIMAL_KIND.readsFeeds, DEFAULT_READS_FEEDS)
}

/** This is what points the web app's direct-publish relay pool at our relay */
export const getDefaultRelays: VerbHandler = async function* (_payload, ctx) {
	yield encodeDefaultRelays([ctx.config.publicRelayUrl])
}

async function* userRelaysFor(pubkeys: string[], ctx: VerbContext): AsyncIterable<unknown> {
	const lists = await ctx.relay.fetch([{ kinds: [10002], authors: pubkeys, limit: pubkeys.length }])
	const byAuthor = new Map(lists.map((e) => [e.pubkey, e]))
	for (const pubkey of pubkeys) {
		const list = byAuthor.get(pubkey)
		const urls =
			list?.tags
				.filter((t) => t[0] === 'r' && typeof t[1] === 'string')
				.map((t) => t[1] as string) ?? []
		yield encodeUserRelays(pubkey, urls.length > 0 ? urls : [ctx.config.publicRelayUrl])
	}
}

export const getUserRelays: VerbHandler = async function* (payload, ctx) {
	const pubkey = requireHex64((payload as Record<string, unknown>)?.pubkey, 'pubkey')
	yield* userRelaysFor([pubkey], ctx)
}

export const getUserRelays2: VerbHandler = async function* (payload, ctx) {
	const raw = (payload as Record<string, unknown>)?.pubkeys
	if (!Array.isArray(raw)) throw new Error('missing pubkeys')
	const pubkeys = raw.map((p) => requireHex64(p, 'pubkey')).slice(0, 100)
	yield* userRelaysFor(pubkeys, ctx)
}

export const getAppReleases: VerbHandler = async function* () {
	yield synthEvent(PRIMAL_KIND.ack, '{}')
}

export const getRecommendedBlossomServers: VerbHandler = async function* () {
	yield synthEvent(PRIMAL_KIND.ack, '[]')
}
