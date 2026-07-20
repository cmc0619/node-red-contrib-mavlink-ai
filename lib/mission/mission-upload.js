'use strict';

const { MissionWorkflow, UPLOAD_STATES } = require('./mission-state-machine');
const { MavlinkError } = require('../util/errors');
const { degToDegE7, degE7ToDeg } = require('../util/geo');

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
    // The item type the vehicle requested (set on the first MISSION_REQUEST(_INT)),
    // so item sends and retransmits answer with the matching MISSION_ITEM(_INT)
    // regardless of the profile's preferred type (#57).
    this._itemUseInt = undefined;
    /**
     * Highest item seq actually sent to the vehicle, so a MISSION_ACK(ACCEPTED)
     * is only honored once the final item (seq count-1) has been transferred
     * and can't complete a partial upload (#145).
     */
    this._maxSeqSent = -1;
    /**
     * Total items sent, for the global stall ceiling: each inbound
     * MISSION_REQUEST resets the per-step retry counter (a re-request is
     * progress in the normal lossy case), so a broken vehicle re-requesting
     * the same seq forever would otherwise spin this workflow indefinitely.
     */
    this._itemSends = 0;
  }

  /**
   * Subscribe to upload responses and send the initial MISSION_COUNT.
   *
   * @returns {void}
   */
  _start() {
    if (this.missionType === this.missionTypeAll) {
      throw new MavlinkError(
        'BAD_MISSION_TYPE',
        'mission_type "all" (255) is only valid for a clear-all; an upload needs a specific mission type.',
        { mission_type: this.missionTypeName }
      );
    }
    this.count = this.items.length;

    this._subscribe(
      { messageNames: ['MISSION_REQUEST_INT', 'MISSION_REQUEST', 'MISSION_ACK'], sysids: [this.targetSystem] },
      (msg) => this._onMessage(msg.payload)
    );

    /**
     * Uploading an empty mission is a clear request: count 0 goes out the same
     * way and the immediate ACCEPTED ack completes it (see the ACK handler's
     * count-0 carve-out).
     */
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
    if (!this._matchesComponent(payload)) {
      return; /** traffic from another component on the same system (#145) */
    }
    if (!this._addressedToUs(payload)) {
      return; /** response meant for another requester on the same vehicle */
    }
    if (!this._matchesMissionType(payload)) {
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
      // Answer with the item type the vehicle actually asked for (#57): a
      // MISSION_REQUEST_INT gets MISSION_ITEM_INT (degE7), a plain MISSION_REQUEST
      // gets MISSION_ITEM (float degrees). The vehicle's request is the clearest
      // compatibility signal, so it overrides the profile's preferred item type;
      // remember the choice so retransmits stay consistent.
      const useIntForItem = payload.name === 'MISSION_REQUEST_INT';
      this._itemUseInt = useIntForItem;
      this._maxSeqSent = Math.max(this._maxSeqSent, seq);
      /**
       * Global ceiling: one nominal send plus maxRetries re-sends per item.
       * Past that, the vehicle is re-requesting without ever acking — fail
       * loudly instead of answering forever.
       */
      this._itemSends += 1;
      if (this._itemSends > this.count * (this.maxRetries + 1)) {
        this._fail(
          new MavlinkError(
            'MISSION_STALLED',
            `Vehicle keeps re-requesting mission items without acking (sent ${this._itemSends} items for a ${this.count}-item mission).`,
            { count: this.count, items_sent: this._itemSends }
          )
        );
        return;
      }
      this._clearTimeout();
      this._retries = 0;
      this._setState(UPLOAD_STATES.SENDING_ITEM);
      this._progress({ seq, count: this.count });
      const name = useIntForItem ? 'MISSION_ITEM_INT' : 'MISSION_ITEM';
      this._send(name, buildItemFields(item, seq, useIntForItem, this.useInt))
        .then(() => {
          this._setState(UPLOAD_STATES.WAITING_REQUEST);
          this._armTimeout(() => this._resendItem(seq));
        })
        .catch((err) => this._fail(err));
      return;
    }

    if (payload.name === 'MISSION_ACK') {
      const result = Number(payload.fields.type);
      /**
       * A stale/duplicate ACCEPTED can arrive before the transfer is really
       * finished — right after MISSION_COUNT (no item pulled yet) or partway
       * through a multi-item upload — and completing then would report success
       * for a mission the vehicle only received a prefix of. Only honor an
       * ACCEPTED once the final item (seq count-1) has actually been sent; a
       * legitimate empty-mission clear (count 0) still completes on its immediate
       * ACCEPTED (#145). The count/item retransmit timeout stays armed so a
       * genuinely stalled upload keeps progressing.
       */
      if (result === this.missionAccepted && this.count > 0 && this._maxSeqSent < this.count - 1) {
        return;
      }
      this._clearTimeout();
      if (result === this.missionAccepted) {
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
    // Resend with the same item type the vehicle requested (#57), falling back
    // to the profile preference if we somehow retransmit before any request.
    const useIntForItem = this._itemUseInt !== undefined ? this._itemUseInt : this.useInt;
    const name = useIntForItem ? 'MISSION_ITEM_INT' : 'MISSION_ITEM';
    this._send(name, buildItemFields(item, seq, useIntForItem, this.useInt))
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
/**
 * Coerce a mission-item param/coordinate while preserving an explicit NaN. PX4
 * uses float NaN as a first-class "use default / keep current" value (e.g.
 * NAV_WAYPOINT param4 = NaN keeps the current heading mode), so the old
 * `value || 0` wrongly forced it to 0 — yaw north on every uploaded waypoint
 * (#142). An explicit number (incl. NaN), a "NaN" string, or null is honored as
 * NaN; undefined falls back to `dflt`; non-numeric garbage also falls back to
 * `dflt` (kept lenient — item shape is validated upstream in upload-input).
 *
 * @param {*} value
 * @param {number} dflt
 * @returns {number}
 */
function keepNanParam(value, dflt) {
  if (value === undefined) {
    return dflt;
  }
  if (value === null) {
    return NaN;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim().toLowerCase() === 'nan') {
    return NaN;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : dflt;
}

function buildItemFields(item, seq, useInt = true, suppliedInt = useInt) {
  let x = item.x;
  let y = item.y;
  /**
   * Raw x/y were authored for the item type the caller expected. The vehicle's
   * request type wins over that expectation (#57), so when the two disagree
   * the raw values must be rescaled: degE7 int32 sent inside a float
   * MISSION_ITEM would command a point ~4e8 degrees away from home, and float
   * degrees inside a MISSION_ITEM_INT collapse to null island.
   *
   * Which convention x/y are IN comes from the item itself when it records
   * its wire provenance (`wire_message`, stamped by a download's extractItem —
   * a downloaded-then-reuploaded MISSION_ITEM carries float degrees no matter
   * what the profile prefers); only unlabeled items fall back to the caller's
   * `suppliedInt` (profile preference). Only finite values rescale
   * (NaN/undefined fall through to keepNanParam).
   */
  const rawIsInt =
    item.wire_message === 'MISSION_ITEM'
      ? false
      : item.wire_message === 'MISSION_ITEM_INT'
        ? true
        : suppliedInt;
  if (rawIsInt !== useInt) {
    if (x !== undefined && Number.isFinite(Number(x))) {
      x = useInt ? degToDegE7(Number(x)) : degE7ToDeg(Number(x));
    }
    if (y !== undefined && Number.isFinite(Number(y))) {
      y = useInt ? degToDegE7(Number(y)) : degE7ToDeg(Number(y));
    }
  }
  if (x === undefined && item.lat !== undefined) {
    x = useInt ? degToDegE7(Number(item.lat)) : Number(item.lat);
  }
  if (y === undefined && item.lon !== undefined) {
    y = useInt ? degToDegE7(Number(item.lon)) : Number(item.lon);
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
    param1: keepNanParam(item.param1, 0),
    param2: keepNanParam(item.param2, 0),
    param3: keepNanParam(item.param3, 0),
    param4: keepNanParam(item.param4, 0),
    x: keepNanParam(x, 0),
    y: keepNanParam(y, 0),
    z: item.z !== undefined ? item.z : item.alt !== undefined ? item.alt : 0
  };
}

module.exports = { MissionUpload, buildItemFields };
