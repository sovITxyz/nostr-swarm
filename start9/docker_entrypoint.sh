#!/bin/bash
set -e

DATA_DIR="/data"
CONFIG_FILE="$DATA_DIR/start9/config.yaml"

# Defaults
export STORAGE_PATH="$DATA_DIR/nostr-swarm-data"
export WS_PORT="3000"
export WS_HOST="0.0.0.0"

# Read config from Start9 config system if available
if [ -f "$CONFIG_FILE" ]; then
    # Parse YAML config using simple shell parsing
    # Start9 setConfig writes a structured YAML file

    get_yaml_value() {
        grep "^$1:" "$CONFIG_FILE" 2>/dev/null | sed "s/^$1: *//" | tr -d '"' | tr -d "'"
    }

    val=$(get_yaml_value "relay-name")
    [ -n "$val" ] && export RELAY_NAME="$val"

    val=$(get_yaml_value "relay-description")
    [ -n "$val" ] && export RELAY_DESCRIPTION="$val"

    val=$(get_yaml_value "relay-contact")
    [ -n "$val" ] && export RELAY_CONTACT="$val"

    val=$(get_yaml_value "relay-pubkey")
    [ -n "$val" ] && export RELAY_PUBKEY="$val"

    val=$(get_yaml_value "swarm-topic")
    [ -n "$val" ] && export SWARM_TOPIC="$val"

    val=$(get_yaml_value "wot-owner-pubkey")
    [ -n "$val" ] && export WOT_OWNER_PUBKEY="$val"

    val=$(get_yaml_value "wot-max-depth")
    [ -n "$val" ] && export WOT_MAX_DEPTH="$val"

    val=$(get_yaml_value "max-message-size")
    [ -n "$val" ] && export MAX_MESSAGE_SIZE="$val"

    val=$(get_yaml_value "max-subscriptions")
    [ -n "$val" ] && export MAX_SUBS="$val"

    val=$(get_yaml_value "event-rate")
    [ -n "$val" ] && export EVENT_RATE="$val"

    val=$(get_yaml_value "req-rate")
    [ -n "$val" ] && export REQ_RATE="$val"
fi

echo "Starting nostr-swarm..."
echo "  Storage: $STORAGE_PATH"
echo "  Port: $WS_PORT"
echo "  Topic: ${SWARM_TOPIC:-nostr}"
echo "  WoT: ${WOT_OWNER_PUBKEY:+enabled (${WOT_OWNER_PUBKEY:0:16}...)}${WOT_OWNER_PUBKEY:-disabled}"

exec node /app/dist/cli.js
