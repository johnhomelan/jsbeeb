// Code ported from Beebem (C to .js) by Jason Robson
// The majority of the commentary here is also from Beebem

// How long a four-way handshake may stall before we resend.
const RetryTimeoutSecs = 0.5;
// How long the line stays in flag fill after we hand a frame to the transport, covering the far
// end's real network round trip. Matches BeebEm's DEFAULT_FLAG_FILL_TIMEOUT (250ms at 2MHz).
const FlagFillTimeoutCycles = 500000;

// Econet support classes
class ADLC {
    constructor() {
        this.control1 = 0;
        this.control2 = 0;
        this.control3 = 0;
        this.control4 = 0;
        this.txfifo = new Uint8Array(3);
        this.rxfifo = new Uint8Array(3);
        this.txfptr = 0; // first empty byte in fifo
        this.rxfptr = 0; // first empty byte in fifo
        this.txftl = 0; // tx fifo tx lst flags. (bits relate to subscripts)
        this.rxffc = 0; // rx fifo fc flags bitss
        this.rxap = 0; // rx fifo ap flags. (bits relate to subscripts)

        this.status1 = 0;
        this.status2 = 0;
        this.sr2pse = 0; // PSE level for SR2 rx bits
        this.cts = 0; // signal up
        this.idle = 0;
    }
}

export class EconetPacket {
    constructor(...values) {
        this.buffer = new Uint8Array(32 * 1024);
        this.pointer = 0;
        this.bytesInBuffer = values.length;
        this.controlFlag = 0;
        this.port = 0;

        // Populate packet contents from values
        for (let i = 0; i < values.length; i++) {
            this.buffer[i] = values[i];
        }
    }

    get full() {
        return this.pointer >= this.buffer.length;
    }
}

export class ReceiveBlock {
    constructor(id, controlFlag, receivePort, bufferStart, bufferEnd) {
        this.id = id;
        this.controlFlag = controlFlag;
        this.receivePort = receivePort;
        this.bufferStart = bufferStart;
        this.bufferEnd = bufferEnd;
        this.data = new EconetPacket();
        this.stationId = 0;
    }
}

// Econet class definition
//
// This models the station's own ADLC (register/FIFO/status/IRQ behaviour, see readRegister,
// writeRegister, updateRegisters, status, checkForNMI) plus the Econet four-way handshake that
// turns bytes flowing through the ADLC's FIFOs into whole frames. The handshake talks to whatever
// `transport` is plugged in via setTransport() rather than to any specific remote party, so the
// same station logic drives both the in-browser fake file server (LocalFilestoreLink) and a real
// remote station reached over AunWebSocketTransport.
//
// Frame addressing throughout mirrors the real Econet wire format: an EconetPacket's buffer
// starts with four routing bytes, [DestStn][DestNet][SrcStn][SrcNet], before any payload — scouts
// carry a control byte and port after that; data blocks repeat the same four routing bytes ahead
// of the actual data (this is genuinely retransmitted per-frame on the wire, not padding).
export class Econet {
    constructor(stationId_, cyclesPerSecond) {
        // Config parameters
        this.TIME_BETWEEN_BYTES = 128;
        this.retryCycles = (cyclesPerSecond * RetryTimeoutSecs) | 0;

        // 4-way handshake states
        this.FWH_Idle = 0;
        this.FWH_RX_Scout_Received = 1;
        this.FWH_RX_ScoutAck_Received = 2;
        this.FWH_RX_Body_Received = 3;
        this.FWH_TX_Scout_Sent = 4;

        // Econet properties
        this.stationId = stationId_;
        this.network = 0;
        this.ADLC = new ADLC();
        this.ADLCprev = new ADLC();
        this.beebTx = new EconetPacket();
        this.beebRx = new EconetPacket();
        // An inbound frame waiting for the Beeb to release RxReset; see presentFrame().
        this.pendingRx = null;

        // The party at the other end of the wire. Null means nothing is plugged in: the ADLC
        // idles exactly as real hardware would with no cable attached.
        this.transport = null;

        // Complete inbound frames (routing header + data) waiting to be walked through the
        // scout/ack/body/ack handshake and delivered into beebRx. Pushed to by deliverInboundUnicast().
        this.inboundQueue = [];

        this.pollTotalCycles = 0;
        this.pollNextTrigger = 0;
        this.powers = [1, 2, 4, 8];

        this.econetNMIEnabled = true;
        this.econetStateChanged = false;
        this.lastNmiControl1 = 0;

        this.wireState = this.FWH_Idle;
        this.wireStateEntryTimer = 0;
        this.statusLight = false;

        // While a frame is in flight to the far end, the line is held in flag fill: the ADLC sees
        // flags (status1 FD) rather than an idle line (status2 RxIdle), which is what keeps the
        // NFS ROM waiting for the reply instead of concluding nobody answered. Cleared when the
        // reply arrives or after FlagFillTimeoutCycles.
        this.flagFillActive = false;
        this.flagFillTimeoutAt = 0;

        // Captured from the outbound scout while we wait for the body (FWH_TX_Scout_Sent).
        this.txDestStn = 0;
        this.txDestNet = 0;
        this.txPort = 0;
        this.txControlFlag = 0;
    }

    /** Plugs in (or unplugs, with `null`) the party at the other end of the wire. */
    setTransport(transport) {
        this.transport = transport;
    }

    /** Applies a station/network address, e.g. once a remote transport's dynamic allocation completes. */
    setAddress(stationId, network = 0) {
        this.stationId = stationId;
        this.network = network;
    }

    /**
     * Called by a transport when a whole Unicast frame has arrived from the network, addressed to
     * this station. Queued rather than delivered immediately: the handshake still has to walk the
     * Beeb through scout -> scout-ack -> body -> body-ack exactly as it would for a real frame
     * arriving over the wire.
     */
    deliverInboundUnicast(srcStn, srcNet, controlByte, port, data) {
        const pkt = new EconetPacket(this.stationId, this.network, srcStn, srcNet);
        pkt.buffer.set(data, 4);
        pkt.bytesInBuffer = 4 + data.length;
        pkt.controlFlag = controlByte;
        pkt.port = port;
        this.inboundQueue.push(pkt);
        this.econetStateChanged = true;
    }

    /**
     * Called by a transport for a direct reply to one of our own broadcasts (e.g. a bridge
     * discovery reply) or immediate operation. These are 2-way exchanges: the reply frame on the
     * wire is just the 4 routing bytes followed by the payload, with no control or port bytes
     * (the requester knows what it asked). The local "machine peek" reply in transmit() has the
     * same shape: its 1, 0, 0x60, 0x03 tail is machine type 0x0001 + NFS version 3.60, all
     * payload, not control/port bytes.
     */
    deliverInboundImmediateReply(srcStn, srcNet, data) {
        this.presentFrame(new EconetPacket(this.stationId, 0, srcStn, srcNet, ...data));
        this.flagFillActive = false;
    }

    /** The far end is dealing with a frame we just sent it; hold the line in flag fill meanwhile. */
    setFlagFill() {
        this.flagFillActive = true;
        this.flagFillTimeoutAt = this.pollTotalCycles + FlagFillTimeoutCycles;
    }

    /**
     * Puts an inbound frame on the Beeb's doorstep. While the Beeb holds its receiver in reset
     * (as it does throughout its own transmissions), the frame waits in pendingRx rather than
     * going straight into beebRx, where updateRegisters() would wipe it before the Beeb ever saw
     * it; polltime() moves it across once RxReset is released. On real hardware this gap doesn't
     * exist: the far end's reply only starts arriving after a turnaround delay, by which time the
     * receiver is listening again.
     *
     * The destination network byte is forced to 0: traffic on the local wire always addresses the
     * local network as 0, and the NFS ROM enforces this on every frame it receives (its receive
     * routines abort unless this byte is 0, or 0xFF for a broadcast). `this.network` is the AUN
     * transport's routing-layer network number, which never appears in this byte on a real wire.
     */
    presentFrame(packet) {
        packet.buffer[1] = 0;
        if (this.ADLC.control1 & 64) {
            this.pendingRx = packet;
        } else {
            this.beebRx = packet;
        }
        this.econetStateChanged = true;
    }

    /**
     * Called by a transport once the far end has accepted an outbound body (transport.sendUnicast's
     * callback). Guarded against late/duplicate calls: if the handshake has already moved on (e.g.
     * the retry timeout in polltime() gave up and synthesised a fallback ack), this is a no-op.
     */
    transportAcked() {
        if (this.wireState !== this.FWH_TX_Scout_Sent) return;
        this.presentFrame(new EconetPacket(this.stationId, this.network, this.txDestStn, this.txDestNet));
        this.flagFillActive = false;
        this.advanceState(this.FWH_Idle);
    }

    copyBuffer(destination, source) {
        destination.bytesInBuffer = source.bytesInBuffer;
        destination.pointer = source.pointer;
        destination.buffer = source.buffer.slice();
    }

    sniffBuffer(data) {
        // Construct a debug string describing the first bytes of the frame
        let length = Math.min(30, data.pointer);
        let outputString = "";

        for (let i = 0; i < length; i++) {
            outputString += (data.buffer[i] < 16 ? "0" : "") + data.buffer[i].toString(16) + " ";
        }

        outputString += "(" + data.pointer + " bytes)";
        return outputString;
    }

    activityLight() {
        return this.statusLight;
    }

    advanceState(stage) {
        this.wireState = stage;
        this.wireStateEntryTimer = this.pollTotalCycles;
        if (this.wireState > 0) {
            this.statusLight = true;
        }
    }

    polltime(cycles) {
        this.pollTotalCycles += cycles;

        if (this.flagFillActive && this.pollTotalCycles >= this.flagFillTimeoutAt) {
            this.flagFillActive = false;
        }

        if (this.pollNextTrigger <= this.pollTotalCycles || this.econetStateChanged) {
            this.econetStateChanged = false;

            if (this.pendingRx && !(this.ADLC.control1 & 64)) {
                this.beebRx = this.pendingRx;
                this.pendingRx = null;
            }

            // A queued frame waits not just for the wire to go idle but for the Beeb to finish
            // reading whatever is already on its doorstep: a reply can arrive in the same poll
            // window as the ack completing our own transmission, and starting the new scout then
            // would overwrite that ack before the Beeb ever saw it.
            const doorstepClear = !this.pendingRx && this.beebRx.bytesInBuffer === 0 && this.ADLC.rxfptr === 0;
            if (this.wireState === this.FWH_Idle && this.inboundQueue.length > 0 && doorstepClear) {
                const pending = this.inboundQueue[0];
                this.presentFrame(
                    new EconetPacket(
                        this.stationId,
                        this.network,
                        pending.buffer[2],
                        pending.buffer[3],
                        pending.controlFlag,
                        pending.port,
                    ),
                );
                this.advanceState(this.FWH_RX_Scout_Received); // 1 - RX Received scout - waiting for ack sent
            }

            if (this.wireState === this.FWH_RX_ScoutAck_Received) {
                const body = new EconetPacket();
                this.copyBuffer(body, this.inboundQueue[0]);
                this.presentFrame(body);
                this.advanceState(this.FWH_RX_Body_Received); // 3 - RX Body received - waiting for final ack
            }

            // Re-tries
            if (this.pollTotalCycles > this.wireStateEntryTimer + this.retryCycles) {
                if (this.wireState !== this.FWH_Idle) {
                    const pending = this.inboundQueue[0];
                    switch (this.wireState) {
                        case this.FWH_RX_Scout_Received:
                            // No ack was sent and we were expecting one, send the scout again
                            this.presentFrame(
                                new EconetPacket(
                                    this.stationId,
                                    this.network,
                                    pending.buffer[2],
                                    pending.buffer[3],
                                    pending.controlFlag,
                                    pending.port,
                                ),
                            );
                            this.advanceState(this.FWH_RX_Scout_Received); // reset timer
                            break;
                        case this.FWH_RX_Body_Received: {
                            const body = new EconetPacket();
                            this.copyBuffer(body, pending);
                            this.presentFrame(body);
                            this.advanceState(this.FWH_RX_Body_Received); // reset timer
                            break;
                        }
                        case this.FWH_RX_ScoutAck_Received:
                            // The Beeb never sent its scout-ack in time; fall back to a bare ack so
                            // the handshake can make forward progress.
                            this.presentFrame(
                                new EconetPacket(this.stationId, this.network, pending.buffer[2], pending.buffer[3]),
                            );
                            this.advanceState(this.FWH_RX_ScoutAck_Received); // reset timer
                            break;
                        case this.FWH_TX_Scout_Sent:
                            // The transport never confirmed our outbound body; fall back to a bare
                            // ack rather than stalling forever.
                            this.presentFrame(
                                new EconetPacket(this.stationId, this.network, this.txDestStn, this.txDestNet),
                            );
                            this.advanceState(this.FWH_TX_Scout_Sent); // reset timer
                            break;
                    }
                } else {
                    this.statusLight = false;
                }
            }

            this.updateRegisters();
            if (this.pollNextTrigger <= this.pollTotalCycles) {
                this.transmit();
                this.receive();
            }
            this.updateIdle();
            this.status();

            return this.checkForNMI();
        }

        return false;
    }

    reset() {
        console.log("Econet: initialisation");

        // Hardware operations:
        // set RxReset and TxReset
        this.ADLC.control1 = 192;
        // reset TxAbort, RTS, LoopMode, DTR
        this.ADLC.control4 = 0; //ADLC.control4 & 223;
        this.ADLC.control2 = 0; //ADLC.control2 & 127;
        this.ADLC.control3 = 0; //ADLC.control3 & 95;

        // clear all status conditions
        this.ADLC.status1 = 0; //cts - clear to send line input (no collissions talking udp)
        this.ADLC.status2 = 0; //dcd - no clock (until sockets initialised and open)
        this.ADLC.sr2pse = 0;
        this.ADLC.rxfptr = 0;
        this.ADLC.rxap = 0;
        this.ADLC.rxffc = 0;
        this.ADLC.txfptr = 0;
        this.ADLC.txftl = 0;
        this.ADLC.idle = 1;
        this.ADLC.cts = 0;

        this.irqcause = 0;
        this.sr1b2cause = 0;
        this.lastNmiControl1 = this.ADLC.control1;

        // Initialise the start trigger of the polling routine
        this.pollNextTrigger = this.pollTotalCycles + this.TIME_BETWEEN_BYTES;
        this.econetStateChanged = true;

        this.inboundQueue = [];
        this.pendingRx = null;
        this.wireState = this.FWH_Idle;
    }

    readRegister(register) {
        if (register === 0) {
            return this.ADLC.status1;
        }
        if (register === 1) {
            return this.ADLC.status2;
        }
        if (register > 1) {
            if ((this.ADLC.control1 & 64) === 0 && this.ADLC.rxfptr) {
                // rxreset not set and something in fifo
                if (this.ADLC.rxfptr) {
                    this.econetStateChanged = true;
                    return this.ADLC.rxfifo[--this.ADLC.rxfptr]; // read rx buffer
                } else {
                    return 0;
                }
            }
        }
        return 0;
    }

    writeRegister(register, value) {
        // Command registers are really just a set of flags that affect
        // operation of the rest of the device.
        if (register === 0) {
            // adr 00
            this.ADLC.control1 = value;
        } else if (register === 1 && !(this.ADLC.control1 & 1)) {
            // adr 01 & AC=0
            this.ADLC.control2 = value;
        } else if (register === 1 && this.ADLC.control1 & 1) {
            // adr 01 & AC=1
            this.ADLC.control3 = value;
        } else if (register === 3 && this.ADLC.control1 & 1) {
            // adr 03 & AC=1
            this.ADLC.control4 = value;
        } else if (register === 2 || register === 3) {
            if ((this.ADLC.control1 & 128) === 0) {
                this.ADLC.txfifo[2] = this.ADLC.txfifo[1];
                this.ADLC.txfifo[1] = this.ADLC.txfifo[0];
                this.ADLC.txfifo[0] = value;
                this.ADLC.txfptr++;
                this.ADLC.txftl = this.ADLC.txftl << 1; ///	shift txlast bits up.
                if (register === 3) this.ADLC.control2 |= 16; // set txlast control flag ourself
            }
        }

        this.econetStateChanged = true;
    }

    updateRegisters() {
        // Save flags
        this.ADLCprev.status1 = this.ADLC.status1;
        this.ADLCprev.status2 = this.ADLC.status2;

        if (this.ADLC.control1 & 32) {
            this.beebRx.pointer = 0;
            this.beebRx.bytesInBuffer = 0;
            this.ADLC.rxfptr = 0;
            this.ADLC.rxap = 0;
            this.ADLC.rxffc = 0;
            this.ADLC.control1 &= ~32; // reset flag
        }

        if (this.ADLC.control2 & 16) {
            // TxLast set
            this.ADLC.txftl |= 1; //	set b0 - flag for fifo[0]
            this.ADLC.control2 &= ~16; // clear flag.
        }

        // CR2b5 - CLR RxST - Clear Receiver Status - reset status bits
        if (this.ADLC.control2 & 32 || this.ADLC.control1 & 64) {
            // or rxreset
            this.ADLC.control2 &= ~32; // clear this bit
            this.ADLC.status1 &= ~10; // clear sr2rq, FD
            this.ADLC.status2 &= ~126; // clear FV, RxIdle, RxAbt, Err, OVRN, DCD

            if (this.ADLC.control2 & 1 && this.ADLC.sr2pse) {
                // PSE active?
                this.ADLC.sr2pse++; // Advance PSE to next priority
                if (this.ADLC.sr2pse > 4) this.ADLC.sr2pse = 0;
            } else {
                this.ADLC.sr2pse = 0;
            }

            this.sr1b2cause = 0; // clear cause of sr2b1 going up
            if (this.ADLC.control1 & 64) {
                // rx reset,clear buffers.
                this.beebRx.pointer = 0;
                this.beebRx.bytesInBuffer = 0;
                this.ADLC.rxfptr = 0;
                this.ADLC.rxap = 0;
                this.ADLC.rxffc = 0;
                this.ADLC.sr2pse = 0;
            }
        }

        // CR2b6 - CLT TxST - Clear Transmitter Status - reset status bits
        if (this.ADLC.control2 & 64 || this.ADLC.control1 & 128) {
            // or txreset
            this.ADLC.control2 &= ~64; // clear this bit
            this.ADLC.status1 &= ~0x70; // clear TXU , cts, TDRA/FC
            if (this.ADLC.cts) {
                this.ADLC.status1 |= 16; //cts follows signal, reset high again
                this.ADLCprev.status1 |= 16; // don't trigger another interrupt instantly
            }
            if (this.ADLC.control1 & 128) {
                // tx reset,clear buffers.
                this.beebTx.pointer = 0;
                this.beebTx.bytesInBuffer = 0;
                this.ADLC.txfptr = 0;
                this.ADLC.txftl = 0;
            }
        }

        if (this.ADLC.control4 & 32) {
            // ABORT
            this.ADLC.txfptr = 0; //	reset fifo
            this.ADLC.txftl = 0; //	reset fifo flags
            this.beebTx.pointer = 0;
            this.beebTx.bytesInBuffer = 0;
            this.ADLC.control4 &= ~32; // reset flag.
        }
    }

    transmit() {
        // Transmit data
        if (!(this.ADLC.control1 & 128)) {
            // tx reset off
            if (this.ADLC.txfptr) {
                // there is data in tx fifo
                let TXlast = false;
                if (this.ADLC.txftl & this.powers[this.ADLC.txfptr - 1]) TXlast = true; // TxLast set
                if (
                    this.beebTx.full || // overflow IP buffer
                    this.ADLC.txfptr > 4
                ) {
                    // overflowed fifo
                    this.ADLC.status1 |= 32; // set tx underrun flag
                    this.beebTx.pointer = 0; // wipe buffer
                    this.beebTx.bytesInBuffer = 0;
                    this.ADLC.txfptr = 0;
                    this.ADLC.txftl = 0;
                } else {
                    this.beebTx.buffer[this.beebTx.pointer] = this.ADLC.txfifo[--this.ADLC.txfptr];
                    this.beebTx.pointer++;
                }
                if (TXlast) {
                    // TxLast set
                    this.beebTx.bytesInBuffer = this.beebTx.pointer;

                    /*console.log(
                        "Econet: " +
                            this.stationId +
                            " TX->" +
                            this.beebTx.buffer[0] +
                            ": " +
                            this.sniffBuffer(this.beebTx)
                    );*/

                    // Is this a broadcast? Unlike a scout, a broadcast has no ack/reply handshake on
                    // the wire: the whole frame (addressed to the wildcard station/network FF.FF)
                    // goes out as a single transmission, so it never fits the 4/6/10-byte shapes the
                    // checks below look for and would otherwise just be silently discarded here.
                    const isBroadcast = this.beebTx.buffer[0] === 0xff && this.beebTx.buffer[1] === 0xff;
                    if (isBroadcast && this.beebTx.bytesInBuffer >= 6) {
                        const data = this.beebTx.buffer.slice(6, this.beebTx.bytesInBuffer);
                        if (this.transport?.sendBroadcast) {
                            this.setFlagFill();
                            this.transport.sendBroadcast(
                                this.stationId,
                                this.network,
                                this.beebTx.buffer[4],
                                this.beebTx.buffer[5],
                                data,
                            );
                        }
                    }

                    // Is this an immediate operation ? Assume it is a machine peek: a hardware-level
                    // peek of whichever station was addressed, not a file-server-level exchange. With
                    // a real transport plugged in, the addressed station is a real remote machine, so
                    // this has to go over the wire like any other frame; only without a transport (or
                    // if the transport doesn't support immediate ops) do we fake a canned local reply,
                    // since there's no real station to actually ask.
                    if (
                        !isBroadcast &&
                        this.beebTx.bytesInBuffer === 10 &&
                        this.beebTx.buffer[5] === 0 &&
                        this.beebTx.buffer[4] >= 0x82 &&
                        this.beebTx.buffer[4] <= 0x88
                    ) {
                        if (this.transport?.sendImmediate) {
                            const data = this.beebTx.buffer.slice(6, this.beebTx.bytesInBuffer);
                            this.setFlagFill();
                            this.transport.sendImmediate(
                                this.beebTx.buffer[0],
                                this.beebTx.buffer[1],
                                this.stationId,
                                this.network,
                                this.beebTx.buffer[4],
                                this.beebTx.buffer[5],
                                data,
                            );
                        } else {
                            this.presentFrame(
                                new EconetPacket(
                                    this.stationId,
                                    this.network,
                                    this.beebTx.buffer[0],
                                    this.beebTx.buffer[1],
                                    1,
                                    0,
                                    0x60,
                                    0x03,
                                ),
                            );
                        }
                    }

                    // Is this an ack?
                    if (this.beebTx.bytesInBuffer === 4) {
                        // if state = 1, move to state 2
                        //if state = 3, clear the pending inbound frame and move to state 0

                        if (this.wireState === this.FWH_RX_Scout_Received) {
                            // 1 - RX Received scout - waiting for ack sent
                            this.advanceState(this.FWH_RX_ScoutAck_Received); // 2 - RX Scout ack received - waiting for body
                        }

                        if (this.wireState === this.FWH_RX_Body_Received) {
                            // 3 - RX Body received - waiting for final ack
                            this.inboundQueue.shift();
                            this.advanceState(this.FWH_Idle);
                        }
                    }

                    // Is this a body ?
                    if (this.beebTx.bytesInBuffer >= 6 && this.wireState === this.FWH_TX_Scout_Sent) {
                        // if at state 4, hand the body to the transport; the transport's callback
                        // (or, for a synchronous local transport, this call itself) drives us on to
                        // state 0 via transportAcked()
                        const data = this.beebTx.buffer.slice(4, this.beebTx.bytesInBuffer);
                        if (this.transport) {
                            // Before the send: a synchronous transport acks (and so clears flag
                            // fill again) inside this call.
                            this.setFlagFill();
                            this.transport.sendUnicast(
                                this.txDestStn,
                                this.txDestNet,
                                this.stationId,
                                this.network,
                                this.txControlFlag,
                                this.txPort,
                                data,
                                () => this.transportAcked(),
                            );
                        } else {
                            this.transportAcked();
                        }
                    }

                    // Is this a scout ?
                    if (!isBroadcast && this.beebTx.bytesInBuffer === 6) {
                        //if state = 0, remember destination/port/control byte
                        // move to state 4 (and ack the scout) if the transport will accept it,
                        // otherwise ignore (matches a real station that isn't listening: silence)

                        if (this.wireState === this.FWH_Idle) {
                            this.txDestStn = this.beebTx.buffer[0];
                            this.txDestNet = this.beebTx.buffer[1];
                            this.txControlFlag = this.beebTx.buffer[4];
                            this.txPort = this.beebTx.buffer[5];

                            if (
                                this.transport &&
                                this.transport.canAcceptScout(this.txDestStn, this.txDestNet, this.txPort)
                            ) {
                                this.presentFrame(
                                    new EconetPacket(this.stationId, this.network, this.txDestStn, this.txDestNet),
                                );
                                this.advanceState(this.FWH_TX_Scout_Sent); //  4 - TX Scout sent - waiting for ack
                            }
                        }
                    }

                    // Wipe the transmit buffer ready for the next frame
                    this.beebTx.pointer = 0;
                    this.beebTx.bytesInBuffer = 0;
                }
            }
        }
    }

    receive() {
        if (!(this.ADLC.control1 & 64)) {
            // rx reset off
            if (this.beebRx.pointer < this.beebRx.bytesInBuffer) {
                // something waiting to be given to the processor
                if (this.ADLC.rxfptr < 3) {
                    // space in fifo
                    this.ADLC.rxfifo[2] = this.ADLC.rxfifo[1];
                    this.ADLC.rxfifo[1] = this.ADLC.rxfifo[0];
                    this.ADLC.rxfifo[0] = this.beebRx.buffer[this.beebRx.pointer];
                    this.ADLC.rxfptr++;
                    this.ADLC.rxffc = (this.ADLC.rxffc << 1) & 7;
                    this.ADLC.rxap = (this.ADLC.rxap << 1) & 7;
                    if (this.beebRx.pointer === 0) this.ADLC.rxap |= 1; // 2 bytes? adr extention mode
                    this.beebRx.pointer++;
                    if (this.beebRx.pointer >= this.beebRx.bytesInBuffer) {
                        // that was last byte!
                        this.ADLC.rxffc |= 1; // set FV flag (this was last byte of frame)

                        /*console.log(
                            "Econet: " +
                                this.stationId +
                                " RX<-" +
                                this.beebRx.buffer[2] +
                                ": " +
                                this.sniffBuffer(this.beebRx)
                        );*/

                        this.beebRx.pointer = 0; // Reset read for next packet
                        this.beebRx.bytesInBuffer = 0;
                    }
                }
            }

            if (this.ADLC.rxfptr === 0) {
                // still nothing in buffers (and thus nothing in Econetrx buffer)
                this.ADLC.control1 &= ~32; // reset discontinue flag
            }
        }

        //----------------------------------------------------------------------------------
        // how long before we come back in here?
        this.pollNextTrigger = this.pollTotalCycles + this.TIME_BETWEEN_BYTES;
    }

    // Recomputed on every polltime pass, not just the TIME_BETWEEN_BYTES-paced receive() ones:
    // a frame delivered between receive() passes must stop the line reading as idle straight
    // away, or the ROM sees a stale "Inactive Idle Received" and gives up on the reply it was
    // waiting for.
    updateIdle() {
        this.ADLC.idle =
            !(this.ADLC.control1 & 0x40) && // not rxreset
            !this.ADLC.rxfptr && // nothing in fifo
            !(this.ADLC.status2 & 2) && // no FV
            this.beebRx.bytesInBuffer === 0; // nothing waiting to be shifted in
    }

    status() {
        // SR1b0 - RDA - received data available.
        if (!(this.ADLC.control1 & 64)) {
            // rx reset off
            if (
                (this.ADLC.rxfptr && !(this.ADLC.control2 & 2)) || // 1 byte mode
                (this.ADLC.rxfptr > 1 && this.ADLC.control2 & 2)
            ) {
                // 2 byte mode
                this.ADLC.status1 |= 1; // set RDA copy
                this.ADLC.status2 |= 128;
            } else {
                this.ADLC.status1 &= ~1;
                this.ADLC.status2 &= ~128;
            }
        }

        // SR1b3 - FD - Flag detected: the line carries flags, not idle, while the far end holds
        // it in flag fill.
        if (this.flagFillActive) {
            this.ADLC.status1 |= 8;
        } else {
            this.ADLC.status1 &= ~8;
        }

        if (this.ADLC.control2 & 128) {
            // clock + RTS
            this.ADLC.cts = false;
            this.ADLC.status1 &= ~16;
        } else {
            this.ADLC.cts = true;
        }

        // and then set the status bit if the line is high! (status bit stays
        // up until cpu tries to clear it) (& still stays up if cts line still high)
        if (this.ADLC.control1 & 128 && this.ADLC.cts) {
            this.ADLC.status1 |= 16; // set CTS now
        }

        // SR1b5 - TXU - Tx Underrun.
        if (this.ADLC.txfptr > 4) {
            // probably not needed
            this.ADLC.status1 |= 32;
            this.ADLC.txfptr = 4;
        }

        // SR1b6 TDRA flag - another complicated derivation
        if (!(this.ADLC.control1 & 128)) {
            // not txreset
            if (!(this.ADLC.control2 & 8)) {
                // tdra mode
                if (
                    ((this.ADLC.txfptr < 3 && !(this.ADLC.control2 & 2)) || // space in fifo?
                        (this.ADLC.txfptr < 2 && this.ADLC.control2 & 2)) && // space in fifo?
                    !(this.ADLC.status1 & 16) && // clear to send is ok
                    !(this.ADLC.status2 & 32)
                ) {
                    // DTR not high

                    this.ADLC.status1 |= 64; // set Tx Reg Data Available flag.
                } else {
                    this.ADLC.status1 &= ~64; // clear Tx Reg Data Available flag.
                }
            } else {
                // FC mode
                if (!this.ADLC.txfptr) {
                    // nothing in fifo
                    this.ADLC.status1 |= 64; // set Tx Reg Data Available flag.
                } else {
                    this.ADLC.status1 &= ~64; // clear Tx Reg Data Available flag.
                }
            }
        }
        // SR1b7 IRQ flag - see below

        // SR2b0 - AP - Address present
        if (!(this.ADLC.control1 & 64)) {
            // not rxreset
            if (this.ADLC.rxfptr && this.ADLC.rxap & this.powers[this.ADLC.rxfptr - 1]) {
                // ap bits set on fifo
                this.ADLC.status2 |= 1;
            } else {
                this.ADLC.status2 &= ~1;
            }
            // SR2b1 - FV -Frame Valid - set in rx - only reset by ClearRx or RxReset
            if (this.ADLC.rxfptr && this.ADLC.rxffc & this.powers[this.ADLC.rxfptr - 1]) {
                this.ADLC.status2 |= 2;
            }
            // SR2b2 - Inactive Idle Received - sets irq!
            if (this.ADLC.idle && !this.flagFillActive) {
                this.ADLC.status2 |= 4;
            } else {
                this.ADLC.status2 &= ~4;
            }
        }

        this.ADLC.status2 &= ~32;
        if (this.ADLC.rxfptr > 4) {
            this.ADLC.status2 |= 64;
            this.ADLC.rxfptr = 4;
        }
        // SR2b7 - RDA. As per SR1b0 - set above.

        // Handle PSE - only for SR2 Rx bits at the moment
        if (this.ADLC.control2 & 1) {
            if (this.ADLC.sr2pse <= 1 && this.ADLC.status2 & 0x7a) {
                // ERR, FV, DCD, OVRN, ABT
                this.ADLC.sr2pse = 1;
                this.ADLC.status2 &= ~0x85;
            } else if (this.ADLC.sr2pse <= 2 && this.ADLC.status2 & 0x04) {
                // Idle
                this.ADLC.sr2pse = 2;
                this.ADLC.status2 &= ~0x81;
            } else if (this.ADLC.sr2pse <= 3 && this.ADLC.status2 & 0x01) {
                // AP
                this.ADLC.sr2pse = 3;
                this.ADLC.status2 &= ~0x80;
            } else if (this.ADLC.status2 & 0x80) {
                // RDA
                this.ADLC.sr2pse = 4;
                this.ADLC.status2 &= ~0x02;
            } else {
                this.ADLC.sr2pse = 0; // No relevant bits set
            }

            // Set SR1 RDA copy
            if (this.ADLC.status2 & 0x80) this.ADLC.status1 |= 1;
            else this.ADLC.status1 &= ~1;
        } else {
            // PSE inactive
            this.ADLC.sr2pse = 0;
        }
    }

    checkForNMI() {
        // Do we need to flag an interrupt?
        let raiseNMI = false;

        // The real chip's IRQ output is a level gated by the RIE/TIE enables, not just by status
        // edges: turning an enable off drops its latched causes from the output at that moment,
        // and turning one on while its status condition is already latched asserts IRQ with no
        // status edge involved. ANFS relies on both when it acks an inbound scout: it masks RIE
        // (dropping the just-serviced RX interrupt's level so a fresh edge is possible at all),
        // then enables TIE with TDRA already high and waits for the interrupt to feed the ack
        // bytes.
        const newlyDisabled = this.lastNmiControl1 & ~this.ADLC.control1;
        const newlyEnabled = this.ADLC.control1 & ~this.lastNmiControl1;
        this.lastNmiControl1 = this.ADLC.control1;
        if (newlyDisabled & 2) this.irqcause &= ~0x0b; // RIE off: drop RDA, S2RQ, FD
        if (newlyDisabled & 4) this.irqcause &= ~0x70; // TIE off: drop CTS, TXU, TDRA
        if (this.irqcause === 0) this.ADLC.status1 &= ~128;
        let enableCause = 0;
        if (newlyEnabled & 4) enableCause |= this.ADLC.status1 & 0x70; // TIE: CTS, TXU, TDRA
        if (enableCause) {
            raiseNMI = true;
            this.irqcause |= enableCause;
            this.ADLC.status1 |= 128;
        }

        if (this.ADLC.status1 !== this.ADLCprev.status1 || this.ADLC.status2 !== this.ADLCprev.status2) {
            // something changed
            let tempcause, temp2;

            // SR1b1 - S2RQ - Status2 request. New bit set in S2?
            tempcause = (this.ADLC.status2 ^ this.ADLCprev.status2) & this.ADLC.status2 & ~128;

            if (!(this.ADLC.control1 & 2)) {
                // RIE not set,
                tempcause = 0;
            }

            if (tempcause) {
                //something got set
                this.ADLC.status1 |= 2;
                this.sr1b2cause = this.sr1b2cause | tempcause;
            } else if (!(this.ADLC.status2 & this.sr1b2cause)) {
                //cause has gone
                this.ADLC.status1 &= ~2;
                this.sr1b2cause = 0;
            }

            // New bit set in S1?
            tempcause = (this.ADLC.status1 ^ this.ADLCprev.status1) & this.ADLC.status1 & ~128;

            if (!(this.ADLC.control1 & 2)) {
                // RIE not set,
                tempcause = tempcause & ~11;
            }
            if (!(this.ADLC.control1 & 4)) {
                // TIE not set,
                tempcause = tempcause & ~0x70;
            }

            if (tempcause) {
                //something got set
                raiseNMI = true;
                this.irqcause = this.irqcause | tempcause; // remember which bit went high to flag irq
                // SR1b7 IRQ flag
                this.ADLC.status1 |= 128;
            }

            // Bit cleared in S1?
            temp2 = (this.ADLC.status1 ^ this.ADLCprev.status1) & this.ADLCprev.status1 & ~128;
            if (temp2) {
                // something went off
                this.irqcause = this.irqcause & ~temp2; // clear flags that went off
                if (this.irqcause === 0) {
                    // all flag gone off now
                    // clear irq status bit when cause has gone.
                    this.ADLC.status1 &= ~128;
                } else {
                    // interrupt again because still have flags set
                    if (this.ADLC.control2 & 1) {
                        raiseNMI = true;
                    }
                }
            }
        }

        return raiseNMI;
    }
}
