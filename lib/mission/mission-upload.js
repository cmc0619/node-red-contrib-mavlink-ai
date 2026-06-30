'use strict';

const { MissionWorkflow, UPLOAD_STATES } = require('./mission-state-machine');
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
  constructor(opts) {
    super(opts);
    this.items = (opts.items || []).map((item, index) => Object.assign({ seq: index }, item));
  }

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

  _sendCount() {
    this._setState(UPLOAD_STATES.WAITING_REQUEST);
    this._progress({ count: this.count });
    this._send('MISSION_COUNT', { count: this.count })
      .then(() => this._armTimeout(() => this._sendCount()))
      .catch((err) => this._fail(err));
  }

  _onMessage(payload) {
    if (!this._matchesTarget(payload)) {
      return;
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
      this._send(name, buildItemFields(item, seq))
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
      if (result === 0) {
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
        this._fail(
          new MavlinkError('MISSION_REJECTED', `Vehicle rejected mission upload (result ${result}).`, {
            result,
            mission_type: this.missionTypeName
          })
        );
      }
    }
  }

  _resendItem(seq) {
    const item = this.items[seq];
    if (!item) {
      return;
    }
    const name = this.useInt ? 'MISSION_ITEM_INT' : 'MISSION_ITEM';
    this._send(name, buildItemFields(item, seq))
      .then(() => this._armTimeout(() => this._resendItem(seq)))
      .catch((err) => this._fail(err));
  }
}

function buildItemFields(item, seq) {
  return {
    seq,
    frame: item.frame !== undefined ? item.frame : 'MAV_FRAME_GLOBAL_RELATIVE_ALT_INT',
    command: item.command,
    current: item.current !== undefined ? item.current : seq === 0 ? 1 : 0,
    autocontinue: item.autocontinue !== undefined ? item.autocontinue : 1,
    param1: item.param1 || 0,
    param2: item.param2 || 0,
    param3: item.param3 || 0,
    param4: item.param4 || 0,
    x: item.x || 0,
    y: item.y || 0,
    z: item.z || 0
  };
}

module.exports = { MissionUpload };
