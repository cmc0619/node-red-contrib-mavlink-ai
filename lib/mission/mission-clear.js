'use strict';

const { MissionWorkflow, MAV_MISSION_ACCEPTED } = require('./mission-state-machine');
const { MavlinkError } = require('../util/errors');

/**
 * Mission clear-with-ack workflow (issue #59).
 *
 *   MISSION_CLEAR_ALL -> MISSION_ACK
 *
 * The node's default clear is best-effort (resolve once sent), because some
 * stacks do not ack a clear of an already-empty mission. This optional workflow
 * gives the same certainty as upload/download: send MISSION_CLEAR_ALL, wait for
 * a MISSION_ACK addressed to us for this mission type, resolve on ACCEPTED,
 * reject on any other result, and retransmit/timeout like the other workflows.
 */
class MissionClear extends MissionWorkflow {
  /**
   * Subscribe to MISSION_ACK and send MISSION_CLEAR_ALL.
   *
   * @returns {void}
   */
  _start() {
    this._subscribe({ messageNames: ['MISSION_ACK'], sysids: [this.targetSystem] }, (msg) => this._onAck(msg.payload));
    this._sendClear();
  }

  /**
   * Send MISSION_CLEAR_ALL and arm a retransmit timeout.
   *
   * @returns {void}
   */
  _sendClear() {
    this._setState('waiting_ack');
    this._progress({});
    // target_system/target_component/mission_type are filled by the base _send.
    this._send('MISSION_CLEAR_ALL', {})
      .then(() => this._armTimeout(() => this._sendClear()))
      .catch((err) => this._fail(err));
  }

  /**
   * Handle a MISSION_ACK: complete on ACCEPTED, fail with the readable result
   * name otherwise.
   *
   * @param {object} payload  decoded §14.1 MISSION_ACK payload
   * @returns {void}
   */
  _onAck(payload) {
    if (!this._matchesTarget(payload) || !this._matchesComponent(payload) || !this._addressedToUs(payload)) {
      return;
    }
    if (!this._matchesMissionType(payload)) {
      return;
    }
    this._clearTimeout();
    const result = Number(payload.fields.type);
    const resultName = this._missionResultName(result);
    if (result === MAV_MISSION_ACCEPTED) {
      this._complete({
        topic: 'mission/cleared',
        payload: {
          target_system: this.targetSystem,
          target_component: this.targetComponent,
          mission_type: this.missionTypeName,
          acked: true,
          result,
          result_name: resultName
        }
      });
    } else {
      this._fail(
        new MavlinkError(
          'MISSION_CLEAR_REJECTED',
          `Vehicle rejected mission clear (result ${result}${resultName ? ` ${resultName}` : ''}).`,
          { result, result_name: resultName, mission_type: this.missionTypeName }
        )
      );
    }
  }
}

module.exports = { MissionClear };
