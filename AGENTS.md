# Agent Instructions

This repo is a clean v2 architecture for a Node-RED MAVLink module.

Follow `DESIGN.md` first. Do not recreate the old coupled architecture.

## Hard rules

1. Do not put dialect selection inside a transport-only node.
2. Do not make a UDP port equal a vehicle.
3. Do not use global singleton parser/connection/dialect state.
4. Do not import `serialport` at module startup.
5. Do not require `serialport` for UDP or TCP usage.
6. Do not bury mission workflow state inside the transport layer.
7. Do not add migration logic from older modules unless explicitly requested.
8. Keep node type names under the `mavlink-ai-*` prefix.

## Architecture

```text
Profile    = MAVLink identity, dialect, defaults
Connection = transport/session/resource owner
Route      = sysid/compid to profile mapping
Nodes      = flow-visible behavior
```

## Preferred implementation order

```text
profile -> protocol -> connection -> UDP -> in/out -> build/filter -> command -> mission -> serial -> TCP
```

## Serial dependency pattern

Bad:

```js
const { SerialPort } = require('serialport');
```

Good:

```js
function loadSerialPort() {
  try {
    return require('serialport');
  } catch (err) {
    throw new Error(
      "Serial transport requires optional dependency 'serialport'. Install it or select UDP/TCP transport."
    );
  }
}
```

## Test expectation

At minimum, keep this passing:

```bash
npm test
```

Add real tests as implementation fills in.
