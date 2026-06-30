# Roadmap

This is the initial build order for `node-red-contrib-mavlink-ai`.

## Phase 0: Skeleton

- [ ] package.json
- [ ] Node-RED node registration
- [ ] README
- [ ] DESIGN.md
- [ ] basic folder layout
- [ ] no-op nodes that load in Node-RED

## Phase 1: Profile layer

- [ ] `mavlink-ai-profile` config node
- [ ] profile type selection
- [ ] dialect selection
- [ ] system/component defaults
- [ ] mission defaults
- [ ] heartbeat identity defaults
- [ ] validation errors for invalid config

## Phase 2: Protocol layer

- [ ] dialect loader
- [ ] bundled dialect support
- [ ] message definition lookup
- [ ] enum lookup
- [ ] encode wrapper
- [ ] decode wrapper
- [ ] message normalizer
- [ ] clear errors for unknown message/dialect failures

## Phase 3: Connection layer

- [ ] `mavlink-ai-connection` config node
- [ ] UDP peer transport
- [ ] connection status
- [ ] clean resource close on redeploy
- [ ] inbound packet decode
- [ ] outbound send queue
- [ ] profile routing mode
- [ ] sysid/compid route table
- [ ] subscription API for regular nodes

## Phase 4: Basic flow nodes

- [ ] `mavlink-ai-in`
- [ ] `mavlink-ai-out`
- [ ] `mavlink-ai-build`
- [ ] `mavlink-ai-filter`
- [ ] HEARTBEAT decode example
- [ ] COMMAND_LONG build/send example

## Phase 5: Commands

- [ ] `mavlink-ai-command`
- [ ] arm
- [ ] disarm
- [ ] set mode
- [ ] land
- [ ] RTL
- [ ] request message
- [ ] set message interval

## Phase 6: Mission protocol

- [ ] mission state machine
- [ ] mission download
- [ ] mission upload
- [ ] mission clear
- [ ] timeout handling
- [ ] retry handling
- [ ] mission lock per connection/profile/mission type
- [ ] progress events
- [ ] SITL test flow

## Phase 7: Optional transports

- [ ] serial transport
- [ ] lazy-load `serialport`
- [ ] helpful error if serial selected but `serialport` missing
- [ ] TCP client
- [ ] TCP server

## Phase 8: Testing

- [ ] unit tests for profile validation
- [ ] unit tests for route matching
- [ ] unit tests for message contracts
- [ ] UDP loopback integration test
- [ ] missing-serialport test
- [ ] recorded heartbeat fixture
- [ ] recorded mission fixture
- [ ] Node-RED manual example flows

## Phase 9: Polish

- [ ] README install instructions
- [ ] README Unraid/Docker dev loop
- [ ] README examples
- [ ] screenshots or flow exports
- [ ] npm package readiness

## Development rule

Do not start by building mission handling.

Build the stack in this order:

```text
profile -> protocol -> connection -> in/out -> build/filter -> command -> mission
```

Mission handling before the connection/subscription model is stable is how software goes to the cornfield.
