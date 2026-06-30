# node-red-contrib-mavlink-ai

A clean v2-style Node-RED MAVLink module designed around profiles, connections, routing, and reusable action nodes.

This repo is intentionally separate from earlier MAVLink Node-RED experiments so both versions can coexist in the same Node-RED runtime.

## Status

Design-first skeleton. Not ready for production use.

## Core idea

```text
Profile    = what MAVLink identity/protocol defaults mean
Connection = how Node-RED talks to a MAVLink network or device
Route      = how sysid/compid packets map to profiles
Nodes      = what actions or filters happen in a flow
```

## Planned Node-RED node types

Config nodes:

```text
mavlink-ai-profile
mavlink-ai-connection
```

Regular flow nodes:

```text
mavlink-ai-in
mavlink-ai-out
mavlink-ai-command
mavlink-ai-mission
mavlink-ai-filter
mavlink-ai-build
```

## Why two config nodes?

A MAVLink vehicle profile is not the same thing as a transport connection.

A copter, rover, and plane may all use the same `ardupilotmega` dialect but still have different defaults, identities, target systems, heartbeat identities, and mission behavior.

A UDP port, serial port, or TCP socket is a connection resource. One UDP port can receive packets from one vehicle or from many MAVLink systems. That routing decision should happen inside the connection layer, not by pretending a UDP socket is the same thing as a vehicle.

## Dependency rule

`node-mavlink` is a core runtime dependency.

`serialport` must be optional and lazy-loaded only when a serial transport is actually configured. UDP/TCP usage must not require serial support.

## Design docs

Start with:

- [`DESIGN.md`](DESIGN.md)
- [`ROADMAP.md`](ROADMAP.md)
