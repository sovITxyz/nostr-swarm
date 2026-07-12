# Procfile -- local dev process group for the nostr-swarm relay + Primal cache shim.
# Run with foreman (`foreman start`) or overmind (`overmind start`) from repo root.
# The Primal UI runs SEPARATELY (it is a different repo); see docs/deployment.md.
#
#   relay -> NIP-01 Nostr relay on ws://localhost:3000
#   shim  -> Primal cache protocol adapter on ws://localhost:8801,
#            which queries the relay at its default ws://127.0.0.1:3000
#
# These use the tsx dev entry (no build step required). For a compiled run,
# `npm run build` first, then swap the two commands to:
#   relay: node dist/cli.js
#   shim:  node dist/cli.js primal-shim
relay: npm run dev
shim: npm run dev:shim
