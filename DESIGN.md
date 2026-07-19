  output carries error envelopes (Command, Fanout, Build, Filter) sends the
  structured `mavlink/error` message there and finishes with `done()`. The
  wired error output is the delivery; the same failure must **not** also
  trigger Catch nodes.
- A node with **no outputs** (Out) finishes with `done(err)` so Catch nodes
  can handle the failure — that is its only delivery path.
- Programmer/internal exceptions (not operational failures) may still use
  `node.error(...)`, but must not duplicate an already-delivered failure.

## 15. Dialect Handling

Dialect handling belongs to the profile/protocol layer.

Supported dialect sources:

```text
bundled: common, ardupilotmega, minimal
local path: mounted file or /data path
custom: user-provided XML path
```

Bundled dialects should live under:

```text
lib/dialects/bundled/
```

Cached or user-provided dialects may live under:

```text
/data/mavlink/dialects/
```

### Trusted operator boundary

The Node-RED editor/admin API is a trusted operator surface: it can configure
live vehicle control and therefore is not a sandbox for mutually untrusted
users. A permitted operator may choose a local or mounted XML dialect and may
retrieve XML or parameter metadata from private-network, self-hosted, or HTTP
sources. This deliberately supports normal hobbyist and lab setups, including
firmware or companion endpoints on RFC1918 addresses.

The driver keeps Node-RED permission middleware and treats downloaded XML as
data, not executable code. Deployers must keep the Node-RED admin interface
authenticated and off the public internet. This trust decision does not weaken
the runtime's separate vehicle-safety obligations: MAVLink/control input must
remain validated and fail closed when stale, malformed, or unsafe.

Bad behavior:

```text
Selected ardupilotmega fails, module silently uses common.
```

Good behavior:

```text
Selected ardupilotmega fails, profile marks invalid, nodes report useful error.
```

Optional advanced setting:

```text
[ ] Fall back to common if dialect load fails
```

Default: unchecked.

Silent fallback is evil because it creates fake success. The node looks alive while message definitions are wrong or missing.

## 16. Protocol Layer

Protocol code should be isolated behind a wrapper.

Suggested files:

```text
lib/protocol/mavlink-codec.js
lib/protocol/message-normalizer.js
lib/protocol/enum-resolver.js
lib/protocol/message-validator.js
