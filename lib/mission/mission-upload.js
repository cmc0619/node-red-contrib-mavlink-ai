'use strict';

const { MissionWorkflow, UPLOAD_STATES, MAV_MISSION_ACCEPTED } = require('./mission-state-machine');
const { MavlinkError } = require('../util/errors');

/**
 * Mission upload workflow (DESIGN.md §24).
 *
 *   MISSION_COUNT -> (MISSION_REQUEST_INT -> MISSION_ITEM_INT)* -> MISSION_ACK
 *
 * The vehicle pulls items by requesting each seq; we respond with the matching
 * item. Completion is signalled by MISSION_ACK with result ACCEPTED.
 */
class MissionUpload extends MissionWorkflow {
  /**
   * @param {object} opts  MissionWorkflow options plus `items` (the mission to
   *   upload); each item is assigned a sequence number by index.
   */
  constructor(opts) {
    super(opts);
    // Sequence numbers are always the array index: items are looked up by the
    // vehicle-requested seq and sent with that seq. A caller-supplied item.seq
    // has no effect and is not merged in, so the code doesn't suggest otherwise.
    this.items = (opts.items || []).slice();
  }

  /**
   * Subscribe to upload responses and send the initial MISSION_COUNT.
   *
   * @returns {void}
   */
  _start() {
    this.count = this.items.length;

    this._subscribe(
      { messageNames: ['MISSION_REQUEST_INT', 'MISSION_REQUEST', 'MISSION_ACK'], sysid: this.targetSystem },
      (msg) => this._onMessage(msg.payload)
    );

    if (this.count === 0) {
      // Uploading an empty mission is a clear request; send count 0 and wait for
      // the ack.
      this._sendCount();
      return;
    }
    this._sendCount();
  }

  /**
   * Send MISSION_COUNT and arm a retransmit timeout.
   *
   * @returns {void}
   */
  _sendCount() {
    this._setState(UPLOAD_STATES.WAITING_REQUEST);
    this._progress({ count: this.count });
    this._send('MISSION_COUNT', { count: this.count })
      .then(() => this._armTimeout(() => this._sendCount()))
      .catch((err) => this._fail(err));
  }

  /**
   * Handle an inbound MISSION_REQUEST(_INT) by sending the requested item, or a
   * MISSION_ACK by completing/failing the upload.
   *
   * @param {object} payload  decoded §14.1 payload
   * @returns {void}
   */
  _onMessage(payload) {
    if (!this._matchesTarget(payload)) {
      return;
    }
    if (!this._addressedToUs(payload)) {
      return; // response meant for another requester on the same vehicle
    }
    if (Number(payload.fields.mission_type) !== this.missionType) {
      return;
    }

    if (payload.name === 'MISSION_REQUEST_INT' || payload.name === 'MISSION_REQUEST') {
      const seq = Number(payload.fields.seq);
      const item = this.items[seq];
      if (!item) {
        this._fail(
          new MavlinkError('MISSION_BAD_SEQ', `Vehicle requested mission item ${seq} which does not exist.`, {
            seq,
            count: this.count
          })
        );
        return;
      }
      this._clearTimeout();
      this._retries = 0;
      this._setState(UPLOAD_STATES.SENDING_ITEM);
      this._progress({ seq, count: this.count });
      const name = this.useInt ? 'MISSION_ITEM_INT' : 'MISSION_ITEM';
      this._send(name, buildItemFields(item, seq, this.useInt))
        .then(() => {
          this._setState(UPLOAD_STATES.WAITING_REQUEST);
          this._armTimeout(() => this._resendItem(seq));
        })
        .catch((err) => this._fail(err));
      return;
    }

    if (payload.name === 'MISSION_ACK') {
      this._clearTimeout();
      const result = Number(payload.fields.type);
      if (result === MAV_MISSION_ACCEPTED) {
        this._complete({
          topic: 'mission/uploaded',
          payload: {
            target_system: this.targetSystem,
            target_component: this.targetComponent,
            mission_type: this.missionTypeName,
            count: this.count
          }
        });
      } else {
        // Resolve the numeric MAV_MISSION_RESULT to its name so a rejection is
        // actionable (e.g. 13 -> MAV_MISSION_RESULT_INVALID_SEQUENCE).
        const resultName = this._missionResultName(result);
        this._fail(
          new MavlinkError(
            'MISSION_REJECTED',
            `Vehicle rejected mission upload (result ${result}${resultName ? ` ${resultName}` : ''}).`,
            {
              result,
              result_name: resultName,
              mission_type: this.missionTypeName
            }
          )
        );
      }
    }
  }

  /**
   * Re-send a mission item that was not acknowledged before the timeout.
   *
   * @param {number} seq
   * @returns {void}
   */
  _resendItem(seq) {
    const item = this.items[seq];
    if (!item) {
      return;
    }
    const name = this.useInt ? 'MISSION_ITEM_INT' : 'MISSION_ITEM';
    this._send(name, buildItemFields(item, seq, this.useInt))
      .then(() => this._armTimeout(() => this._resendItem(seq)))
      .catch((err) => this._fail(err));
  }
}

/**
 * Build the MISSION_ITEM(_INT) field set for an item, filling sensible defaults
 * (frame, current flag on item 0, autocontinue, zeroed params/coords).
 *
 * Coordinates: `lat`/`lon` are always plain float degrees and are converted to
 * the wire scaling automatically — degE7 int32 for MISSION_ITEM_INT, float
 * degrees for MISSION_ITEM. Explicit `x`/`y` are raw wire values and take
 * precedence for callers that already speak the wire convention.
 *
 * @param {object} item
 * @param {number} seq
 * @param {boolean} [useInt=true]  whether the *_INT message is being sent
 * @returns {object}
 */
function buildItemFields(item, seq, useInt = true) {
  let x = item.x;
  let y = item.y;
  if (x === undefined && item.lat !== undefined) {
    x = useInt ? Math.round(Number(item.lat) * 1e7) : Number(item.lat);
  }
  if (y === undefined && item.lon !== undefined) {
    y = useInt ? Math.round(Number(item.lon) * 1e7) : Number(item.lon);
  }
  return {
    seq,
    frame:
      item.frame !== undefined
        ? item.frame
        : useInt
        ? 'MAV_FRAME_GLOBAL_RELATIVE_ALT_INT'
        : 'MAV_FRAME_GLOBAL_RELATIVE_ALT',
    command: item.command,
    current: item.current !== undefined ? item.current : seq === 0 ? 1 : 0,
    autocontinue: item.autocontinue !== undefined ? item.autocontinue : 1,
    param1: item.param1 || 0,
    param2: item.param2 || 0,
    param3: item.param3 || 0,
    param4: item.param4 || 0,
    x: x || 0,
    y: y || 0,
    z: item.z !== undefined ? item.z : item.alt !== undefined ? item.alt : 0
  };
}

module.exports = { MissionUpload, buildItemFields };
