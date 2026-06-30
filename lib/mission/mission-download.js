'use strict';

const { MissionWorkflow, DOWNLOAD_STATES } = require('./mission-state-machine');

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
      this.items.push(extractItem(payload.fields));
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
    // MISSION_ACK: type 0 = MAV_MISSION_RESULT_ACCEPTED.
    this._send('MISSION_ACK', { type: 0 })
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
 * @param {object} fields
 * @returns {object}
 */
function extractItem(fields) {
  return {
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
}

module.exports = { MissionDownload };
