'use strict';

const { coreEnumMember } = require('../protocol/protocol-values');

/**
 * Well-known MAVLink component ids for payload addressing (#155).
 *
 * A payload verb (camera, gimbal, servo, ...) is a COMMAND_LONG addressed to a
 * `target_component`. Which component actually hosts the device is a real
 * decision, not an afterthought:
 *
 *  - On ArduPilot the camera and gimbal are usually driven by the flight
 *    controller itself, so their commands are answered by the **autopilot**
 *    component (`MAV_COMP_ID_AUTOPILOT1` = 1). This is why the payload node's
 *    default target component is the autopilot / profile default: it is the
 *    working default for the most common setup, chosen deliberately — not an
 *    accident of "component 1 is the first id".
 *  - A standalone MAVLink camera announces itself on `MAV_COMP_ID_CAMERA`
 *    (100+); a standalone gimbal on `MAV_COMP_ID_GIMBAL` (154). Commands sent to
 *    the autopilot component are silently ignored by such a device, so the
 *    operator must address it explicitly.
 *
 * The editor surfaces these ids (a datalist + a verb-aware hint) so the choice
 * is visible; this module is the runtime source of truth the node references.
 */

/** MAVLink MAV_COMPONENT ids relevant to payload/peripheral addressing. */
const MAV_COMP_ID = {
  /** The flight controller. ArduPilot's onboard camera/gimbal drivers answer here. */
  AUTOPILOT1: coreEnumMember('MavComponent', 'AUTOPILOT1', { consumer: 'payload-components' }),
  /** First dedicated MAVLink camera. Cameras occupy the 100..105 range. */
  CAMERA: coreEnumMember('MavComponent', 'CAMERA', { consumer: 'payload-components' }),
  /** A dedicated MAVLink gimbal / mount. */
  GIMBAL: coreEnumMember('MavComponent', 'GIMBAL', { consumer: 'payload-components' })
};

/**
 * The default target component when neither the message, the node, nor the
 * profile specifies one: the autopilot component. Named (rather than a bare
 * `1`) so the deliberate choice is self-documenting at the call site (#155).
 */
const DEFAULT_TARGET_COMPONENT = MAV_COMP_ID.AUTOPILOT1;

module.exports = { MAV_COMP_ID, DEFAULT_TARGET_COMPONENT };
