/**
 * The verb registry: every cache verb the Primal web app can send, mapped to
 * its handler. Verbs listed as stubs answer with bare EOSE — the client
 * degrades to an empty state for all of them. Anything not listed at all is
 * also answered with EOSE (plus a debug log) by the message handler.
 */

import type { LiveVerbHandler, VerbHandler } from '../handler.js'
import { broadcastEvents, importEvents } from './broadcast.js'
import {
	directmsgCount,
	getDirectMsgs,
	getDirectmsgContacts,
	resetDirectmsgCount,
	resetDirectmsgCounts,
} from './dms.js'
import {
	events,
	parametrizedReplaceableEvent,
	parametrizedReplaceableEvents,
	replaceableEvent,
} from './events.js'
import {
	exploreMedia,
	explorePeople,
	exploreTopics,
	exploreZaps,
	scored,
	scoredUsers24h,
} from './explore.js'
import { feedDirective, longFormContentFeed } from './feeds.js'
import {
	getNotifications,
	getNotificationsSeen,
	notificationCounts,
	setNotificationsSeen,
} from './notifications.js'
import { advancedFeed, search } from './search.js'
import {
	getAppReleases,
	getAppSettings,
	getAppSubsettings,
	getDefaultAppSettings,
	getDefaultRelays,
	getHomeFeeds,
	getReadsFeeds,
	getRecommendedBlossomServers,
	getUserRelays,
	getUserRelays2,
	setAppSettings,
	setAppSubsettings,
	setPrimalProtocol,
} from './settings.js'
import { threadView } from './thread.js'
import {
	contactList,
	getBookmarks,
	isUserFollowing,
	mutelist,
	userFollowers,
	userInfos,
	userProfile,
	userSearch,
} from './users.js'

/** Answered with bare EOSE: the UI shows an empty state, nothing breaks */
// biome-ignore lint/correctness/useYield: the empty response is the point
const stub: VerbHandler = async function* () {}

const STUB_VERBS = [
	'net_stats',
	// 'explore' route is disabled in the client; leave it stubbed
	'explore',
	'explore_legend_counts',
	'explore_global_trending_24h',
	'explore_global_mostzapped_4h',
	'scored_users',
	'get_reads_topics',
	'get_featured_authors',
	'creator_paid_tiers',
	'get_featured_dvm_feeds',
	'dvm_feed_info',
	'get_advanced_feeds',
	'parse_advanced_search_query',
	'get_suggested_users',
	'mutelists',
	'allowlist',
	'parameterized_replaceable_list',
	'search_filterlist',
	'event_actions',
	'note_mentions',
	'note_mentions_count',
	'event_zaps_by_satszapped',
	'find_reposts',
	'get_highlights',
	'drafts',
	'get_drafts',
	'poll_votes',
	'import_poll_vote_event',
	'get_recommended_reads',
	'live_feed',
	'live_events_from_follows',
	'find_live_events',
	'report_user',
	'get_filterlist',
	'check_filterlist',
	'trusted_users',
	'nostr_stats',
	'is_hidden_by_content_moderation',
	'user_of_ln_address',
	'nip19_decode',
	'mutual_follows',
	'user_zaps_sent',
	'membership_status',
	'rebroadcasting_status',
	'user_profile_followed_by',
	'user_profile_scored_content',
	'user_profile_scored_media_thumbnails',
	'long_form_content_thread_view',
]

export function buildVerbRegistry(): Map<string, VerbHandler> {
	const registry = new Map<string, VerbHandler>()

	// Boot / settings
	registry.set('set_primal_protocol', setPrimalProtocol)
	registry.set('get_default_app_settings', getDefaultAppSettings)
	registry.set('get_app_settings', getAppSettings)
	registry.set('set_app_settings', setAppSettings)
	registry.set('get_app_subsettings', getAppSubsettings)
	registry.set('set_app_subsettings', setAppSubsettings)
	registry.set('get_home_feeds', getHomeFeeds)
	registry.set('get_reads_feeds', getReadsFeeds)
	registry.set('get_default_relays', getDefaultRelays)
	registry.set('get_user_relays', getUserRelays)
	registry.set('get_user_relays_2', getUserRelays2)
	registry.set('get_app_releases', getAppReleases)
	registry.set('get_recommended_blossom_servers', getRecommendedBlossomServers)

	// Feeds / thread / events
	registry.set('mega_feed_directive', feedDirective)
	registry.set('multi_kind_mega_feed_directive', feedDirective)
	registry.set('long_form_content_feed', longFormContentFeed)
	registry.set('thread_view', threadView)
	registry.set('multi_kind_thread_view', threadView)
	registry.set('events', events)
	registry.set('replaceable_event', replaceableEvent)
	registry.set('parametrized_replaceable_event', parametrizedReplaceableEvent)
	registry.set('parametrized_replaceable_events', parametrizedReplaceableEvents)

	// Users
	registry.set('user_infos', userInfos)
	registry.set('user_profile', userProfile)
	registry.set('contact_list', contactList)
	registry.set('is_user_following', isUserFollowing)
	registry.set('user_followers', userFollowers)
	registry.set('get_bookmarks', getBookmarks)
	registry.set('mutelist', mutelist)

	// Search
	registry.set('search', search)
	registry.set('user_search', userSearch)
	registry.set('advanced_feed', advancedFeed)

	// Explore / trending (approximated from relay engagement)
	registry.set('scored', scored)
	registry.set('scored_users_24h', scoredUsers24h)
	registry.set('explore_media', exploreMedia)
	registry.set('explore_zaps', exploreZaps)
	registry.set('explore_topics', exploreTopics)
	registry.set('explore_people', explorePeople)

	// Direct messages (NIP-04, kind 4)
	registry.set('get_directmsgs', getDirectMsgs)
	registry.set('get_directmsg_contacts', getDirectmsgContacts)
	registry.set('reset_directmsg_count', resetDirectmsgCount)
	registry.set('reset_directmsg_counts', resetDirectmsgCounts)

	// Notifications
	registry.set('get_notifications', getNotifications)
	registry.set('get_notifications_seen', getNotificationsSeen)
	registry.set('set_notifications_seen', setNotificationsSeen)

	// Publishing
	registry.set('broadcast_events', broadcastEvents)
	registry.set('import_events', importEvents)

	for (const verb of STUB_VERBS) {
		registry.set(verb, stub)
	}
	return registry
}

export function buildLiveVerbRegistry(): Map<string, LiveVerbHandler> {
	const registry = new Map<string, LiveVerbHandler>()
	registry.set('notification_counts', notificationCounts)
	registry.set('directmsg_count', directmsgCount)
	return registry
}
