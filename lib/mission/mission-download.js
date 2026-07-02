'use strict';

const {
  MissionWorkflow,
  DOWNLOAD_STATES,
  MAV_MISSION_ACCEPTED,
  GLOBAL_FRAMES
} = require('./mission-state-machine');

/**
 * Mission download workflow (DESIGN.md §24).
 *
 *   REQUEST_LIST -> MISSION_COUNT -> (REQUEST_INT/ITEM)* -> MISSION_ACK
 *
 * Items are requested one at a time, in order, with per-item retransmit on
 * timeout. The assembled mission is returned as the §24 completed-mission
 * object.
 */
class MissionDownload extends MissionWorkflow {
  /**
   * Subscribe to mission responses and send the initial request list.
   *
   * @returns {void}
   */
  _start() {
    this.count = 0;
    this.items = [];
    this.expectedSeq = 0;

    this._subscribe(
      { messageNames: ['MISSION_COUNT', 'MISSION_ITEM_INT', 'MISSION_ITEM'], sysid: this.targetSystem },
      (msg) => this._onMessage(msg.payload)
    );

    this._requestList();
  }

  /**
   * Send MISSION_REQUEST_LIST and arm a retransmit timeout.
   *
   * @returns {void}
   */
  _requestList() {
    this._setState(DOWNLOAD_STATES.WAITING_COUNT);
    this._progress({});
    this._send('MISSION_REQUEST_LIST', {})
      .then(() => this._armTimeout(() => this._requestList()))
      .catch((err) => this._fail(err));
  }

  /**
   * Request a single mission item by sequence number and arm a retransmit.
   *
   * @param {number} seq
   * @returns {void}
   */
  _requestItem(seq) {
    this.expectedSeq = seq;
    this._setState(DOWNLOAD_STATES.WAITING_ITEM);
    this._progress({ seq, count: this.count });
    const name = this.useInt ? 'MISSION_REQUEST_INT' : 'MISSION_REQUEST';
    this._send(name, { seq })
      .then(() => this._armTimeout(() => this._requestItem(seq)))
      .catch((err) => this._fail(err));
  }

  /**
   * Handle an inbound MISSION_COUNT / MISSION_ITEM(_INT), advancing the download
   * state machine and requesting the next item until the mission is assembled.
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

    if (payload.name === 'MISSION_COUNT' && this.state === DOWNLOAD_STATES.WAITING_COUNT) {
      this._clearTimeout();
      this._retries = 0;
      this.count = Number(payload.fields.count);
      if (this.count === 0) {
        this._finish();
        return;
      }
      this._requestItem(0);
      return;
    }

    if (
      (payload.name === 'MISSION_ITEM_INT' || payload.name === 'MISSION_ITEM') &&
      this.state === DOWNLOAD_STATES.WAITING_ITEM
    ) {
      const seq = Number(payload.fields.seq);
      if (seq !== this.expectedSeq) {
        // Out-of-order or duplicate; ignore and let the timeout re-request.
        return;
      }
      this._clearTimeout();
      this._retries = 0;
      this.items.push(extractItem(payload.fields, payload.name));
      this._progress({ seq, count: this.count });
      const next = seq + 1;
      if (next >= this.count) {
        this._finish();
      } else {
        this._requestItem(next);
      }
    }
  }

  /**
   * Acknowledge the mission (best-effort) and resolve with the assembled
   * `mission/downloaded` result.
   *
   * @returns {void}
   */
  _finish() {
    this._setState(DOWNLOAD_STATES.SENDING_ACK);
    this._progress({ count: this.count });
    this._send('MISSION_ACK', { type: MAV_MISSION_ACCEPTED })
      .catch(() => {}) // best-effort ack; we already have all items
      .then(() => {
        this._complete({
          topic: 'mission/downloaded',
          payload: {
            target_system: this.targetSystem,
            target_component: this.targetComponent,
            mission_type: this.missionTypeName,
            count: this.count,
            items: this.items
          }
        });
      });
  }
}

/**
 * Project a decoded MISSION_ITEM(_INT) fields object into the compact mission
 * item shape used in the completed-mission result.
 *
 * x/y keep the raw wire values, whose meaning depends on the message type:
 * MISSION_ITEM_INT stores degE7 int32 for global frames while MISSION_ITEM
 * stores float degrees. Because a vehicle may answer with either type, each
 * item records the wire message it came from and — for global frames — adds
 * unambiguous `lat`/`lon` in plain float degrees.
 *
 * @param {object} fields
 * @param {string} [messageName]  'MISSION_ITEM_INT' or 'MISSION_ITEM'
 * @returns {object}
 */
function extractItem(fields, messageName) {
  const item = {
    seq: Number(fields.seq),
    frame: fields.frame,
    command: fields.command,
    current: fields.current,
    autocontinue: fields.autocontinue,
    param1: fields.param1,
    param2: fields.param2,
    param3: fields.param3,
    param4: fields.param4,
    x: fields.x,
    y: fields.y,
    z: fields.z
  };
  if (messageName) {
    item.wire_message = messageName;
  }
  const frame = Number(fields.frame);
  if (GLOBAL_FRAMES.has(frame)) {
    const isInt = messageName === 'MISSION_ITEM_INT';
    item.lat = isInt ? Number(fields.x) / 1e7 : Number(fields.x);
    item.lon = isInt ? Number(fields.y) / 1e7 : Number(fields.y);
  }
  return item;
}

module.exports = { MissionDownload, extractItem };
