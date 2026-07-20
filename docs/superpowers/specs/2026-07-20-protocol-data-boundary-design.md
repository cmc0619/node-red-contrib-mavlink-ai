# Protocol Data Boundary Design

## Status

Approved in conversation on 2026-07-20.

## Goal

Make `node-mavlink` and its generated dialect mappings authoritative for MAVLink enum names and numeric assignments throughout the repository. Remove locally copied protocol tables and numeric fallbacks without changing the project-owned routing, transport, workflow, queue, or Node-RED message-contract architecture.

This is a deliberate pre-1.0 breaking change. Existing aliases and deprecated names will not be preserved. A flow using a removed name may break and must be updated to the current generated canonical name.

In this document, a canonical or generated member name means the exact forward key exported by the generated enum object. Examples are `COMPONENT_ARM_DISARM` in `MavCmd`, `GLOBAL_INT` in `MavFrame`, and `FLY_BY_WIRE_A` in `PlaneMode`.

## Motivation

The codec already delegates packet splitting, parsing, data-class decoding, V1/V2 serialization, checksums, and signing primitives to `node-mavlink`. The main avoidable duplication is protocol data copied into project files: ArduPilot flight modes, MAVLink results, mission types, frames, parameter types, component identifiers, capability bits, payload action values, and selected command identifiers.

Copied tables can drift from the installed generated mappings. The current ArduPilot mode table demonstrates that risk: it omits generated members such as Plane and Rover `INITIALIZING` and Sub `SURFTRAK`, while exposing local spellings such as `FBWA`, `FBWB`, `MOTOR_DETECT`, and `INITIALISING` instead of the generated names.

## Non-goals

- Do not upgrade or fork `node-mavlink`.
- Do not submit upstream changes.
- Do not replace the connection, routing, transport, outbound queue, subscription registry, or workflow state machines with `node-mavlink` convenience helpers.
- Do not remove the tested codec workarounds required by `node-mavlink` 2.3.0.
- Do not add compatibility aliases, numeric fallbacks, deprecation warnings, or flow migration code.
- Do not remove the advanced/raw ability to supply a numeric custom or dialect-external MAVLink identifier.
- Do not change the public decoded or outbound Node-RED message shapes.

## Dependency boundary

Code outside `lib/protocol` and `lib/dialects` must not own MAVLink numeric assignments. It may own project policy expressed with canonical enum names.

The preferred dependency path is:

```text
Node-RED nodes and workflows
        -> canonical enum names
protocol-values / enum-resolver
        -> active dialect bundle or bundled core definitions
        -> node-mavlink public exports
        -> generated mavlink-mappings data
```

`node-mavlink` publicly re-exports the generated dialect modules. The new protocol-data boundary should consume those public exports when resolving universal and bundled protocol values.

Two existing direct uses of `mavlink-mappings` remain documented exceptions because `node-mavlink` does not provide equivalent APIs:

1. Locating bundled `.d.ts` files for editor descriptions and field-to-enum metadata.
2. Runtime custom-XML compilation into live message classes and dialect registries.

## Protocol-value interface

Add `lib/protocol/protocol-values.js` as the strict internal boundary over the existing permissive `lib/protocol/enum-resolver.js`.

It provides these conceptual operations:

- `requireEnumMember(index, enumName, memberKey, context)` returns a numeric enum value. `memberKey` must be the exact forward key exported by the generated enum object, such as `COMPONENT_ARM_DISARM`, `GLOBAL_INT`, or `FLY_BY_WIRE_A`. It throws when the enum or member is unavailable.
- `enumMembers(index, enumName, context)` returns generated canonical names and values for editor choices and firmware-mode tables.
- `coreEnumMember(enumName, memberKey, context)` resolves values from a cached core index built from the `minimal`, `standard`, and `common` dialect modules exported by `node-mavlink`.

`context` identifies the consuming feature and active dialect for diagnostics. Failures use a structured `MavlinkError` with code `ENUM_VALUE_UNAVAILABLE` and include:

- `enum`: compiled enum class name, such as `MavCmd`.
- `member`: requested canonical member name.
- `dialect`: active dialect when available.
- `consumer`: workflow or feature requesting the value.

Internal policy definitions must use `requireEnumMember` or `coreEnumMember`. They must not pass numbers, numeric strings, locally invented aliases, or a prefixed alternate spelling in place of the generated member key.

Raw flow inputs and the generic outbound builder continue using the existing scoped `resolveInEnum` behavior, including its support for fully qualified MAVLink source names. Numbers remain valid there because MAVLink permits custom and dialect-external identifiers. This is an intentional general-purpose interface, not a compatibility path. The breaking alias removal applies to feature-specific local tables and choices, not to the generic enum resolver.

## Resolution rules

1. Resolve dialect-dependent values from the selected Vehicle Profile's active dialect bundle.
2. Resolve values needed before a Vehicle Profile exists from the cached bundled core index.
3. Never silently fall back to `common`, a copied number, an alias, or a deprecated spelling.
4. Keep generated dependency objects inside the protocol/dialect layer. Other code continues to exchange plain objects and numeric wire fields.
5. Let custom dialect definitions win through their active dialect bundle.
6. Resolve configuration-time values during deployment where possible. Resolve message-dependent values at build/send time through the node's existing structured error path.

## Migration scope

### Flight modes

Remove the copied `ARDUPILOT_MODES` tables from `lib/command/flight-modes.js`.

Map Vehicle Profile families to generated enum classes:

- `copter` -> `CopterMode`
- `plane` -> `PlaneMode`
- `rover` and `boat` -> `RoverMode`
- `sub` -> `SubMode`
- `antenna-tracker` -> `TrackerMode`

Mode choices, forward resolution, and reverse lookup use generated members. Remove local aliases including `FBWA`, `FBWB`, `MOTOR_DETECT`, and `INITIALISING`. Generated names such as `FLY_BY_WIRE_A`, `FLY_BY_WIRE_B`, `MOTORDETECT`, `INITIALIZING`, and `SURFTRAK` are authoritative when present.

Keep PX4 `custom_mode` main/submode tables and packing locally. Those values are firmware conventions rather than MAVLink dialect enums.

### Commands and priority

- Resolve `MavResult.ACCEPTED` and `MavResult.IN_PROGRESS` through the active dialect.
- Express the critical-command policy as exact generated `MavCmd` member keys and resolve it against `MavCmd`.
- Remove copied numeric command comparisons in the Command and Formation nodes.
- Keep command retry, ACK matching, locking, confirmation, and priority-band policy project-owned.

### Missions

- Map friendly mission types to canonical `MavMissionType` members.
- Resolve accepted mission results from `MavMissionResult`.
- Express the set of global-coordinate frames using canonical `MavFrame` members.
- Keep mission protocol sequencing, retries, item validation, and coordinate conversion project-owned.

### Parameters

- Key integer type conversion and range policy using canonical `MavParamType` members resolved through the active dialect.
- Resolve parameter-encoding capability bits from `MavProtocolCapability`.
- Keep JavaScript numeric ranges, `DataView` accessors, PX4 byte-union behavior, and firmware metadata parsing project-owned.

### Move and setpoints

- Compose position-target masks from generated `PositionTargetTypemask` members.
- Resolve coordinate frames through `MavFrame` without a copied numeric fallback table.
- Keep the inverted-mask grouping, NED conversions, preset semantics, and finite-value validation project-owned.

### Payloads and components

- Map friendly payload verbs to canonical members of `MavMountMode`, `GripperActions`, `CameraMode`, `CameraZoomType`, `SetFocusType`, `WinchActions`, `ParachuteAction`, and relevant gimbal flag enums.
- Resolve default and dedicated component identifiers from `MavComponent`.
- Friendly verbs remain part of the Node-RED UX, but their mappings contain canonical member names rather than numbers.

### Swarm and Local Identity

- Resolve armed-state flags through `MavModeFlag`.
- Resolve GCS exclusion and vehicle/autopilot classification through `MavType` and `MavAutopilot`.
- Keep the mapping from canonical vehicle-type names to project Vehicle Profile family names as local policy.
- Resolve Local Identity component defaults through `MavComponent`. Source system-id defaults remain local configuration policy because system IDs are addresses, not enum assignments.

### Connection and codec

- Use exported `node-mavlink` constants such as the signed incompatibility flag where public constants exist.
- Retain codec frame offsets and byte-level repairs required for splitter resynchronization, V1 extension truncation, minimum V2 payload length, exact PX4 float bits, V1 magic reporting, and HEARTBEAT version stamping.
- Do not replace per-link sequence/signing state with the global state inside `node-mavlink` send helpers.

## Application policy versus protocol data

Local tables remain valid when they describe application behavior rather than protocol assignments. They must refer to protocol values by canonical name.

Examples of retained policy:

- Friendly payload verb -> exact generated enum member key.
- Critical command set -> exact generated `MavCmd` member keys.
- Global-frame behavior -> exact generated `MavFrame` member keys.
- MAV type name -> internal `copter`, `plane`, `rover`, `boat`, or `sub` family.
- Parameter type name -> JavaScript `DataView` accessor and numeric range.
- Position-target dimension -> set of canonical mask member names.

Timeouts, retry counts, queue priorities, buffer limits, geographic constants, and JavaScript integer limits are not MAVLink enum assignments and remain numeric.

## Error behavior

- A missing enum or canonical member fails loudly with `ENUM_VALUE_UNAVAILABLE`.
- The error identifies the enum, member, dialect, and consumer.
- No resolution path substitutes a legacy alias or numeric fallback.
- Invalid Vehicle Profiles continue using the existing profile-invalid failure behavior.
- Deployment-time configuration errors prevent the affected node from operating.
- Runtime message errors use the node's existing dedicated error output or `done(err)` contract.

## Testing strategy

### Protocol-value tests

Add focused tests covering:

- Successful core enum resolution.
- Successful active-dialect resolution.
- Merged enum resolution across included dialect modules.
- Custom-dialect resolution.
- Missing enum and missing member errors with complete context.
- Rejection of numeric strings, prefixed alternate spellings, and locally invented aliases by strict internal helpers.
- Continued numeric support through the explicit raw/scoped resolver.

### Flight-mode tests

Compare mode choices and reverse lookup against the installed generated enum objects rather than repeating numeric values in test fixtures.

Verify:

- Generated names are accepted.
- Generated members omitted by the old local tables are exposed.
- Removed aliases fail.
- PX4 packing and aliases that are part of the intentional PX4 UX remain unchanged.

### Consumer tests

For command, mission, parameter, move, payload, swarm, priority, formation, and Local Identity behavior:

- Derive expected values from generated enum exports.
- Preserve existing workflow, retry, routing, and output-contract assertions.
- Test structured failure when the required enum data is absent.
- Preserve tests for explicit raw numeric custom IDs.

### Repository audit

After migration, inspect production JavaScript for copied MAVLink assignments and numeric command comparisons. Every surviving protocol-adjacent number must fall into one of these categories:

- Project policy or timing.
- JavaScript or wire-type range.
- Address supplied by configuration rather than an enum.
- Tested codec workaround.

Run targeted tests after each migration group, then run:

```text
npm test
npm run lint
git diff --check
```

## Documentation

- Update README and node help where accepted mode names or enum behavior changes.
- Add a CHANGELOG entry identifying this as a breaking pre-1.0 cleanup.
- Document exact generated member keys as the only supported feature-specific friendly enum names.
- Preserve and document the generic builder's separate scoped resolution of fully qualified MAVLink source names and raw numeric identifiers.
- Document raw numeric inputs only as an advanced custom/dialect-external escape hatch.
- Do not publish an alias or migration table.

## Delivery sequence

1. Add the strict protocol-value boundary and its tests.
2. Replace ArduPilot flight-mode copies.
3. Migrate command, mission, and parameter protocol data.
4. Migrate move, payload, swarm, priority, formation, Local Identity, and connection constants.
5. Complete the numeric-assignment audit.
6. Update documentation and CHANGELOG.
7. Run the complete verification suite.

Each stage must be independently testable and reviewable. No stage removes a codec workaround or changes transport/workflow ownership.
