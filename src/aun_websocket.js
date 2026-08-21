import { typedArrayToBase64, base64ToTypedArray } from "./state-utils.js";

// AUN packet types (the first byte of the 8-byte AUN header carried in a `pkt` message's payload).
const AunType = { Broadcast: 1, Unicast: 2, Ack: 3, Reject: 4, Immediate: 5, ImmediateReply: 6 };

function encodeAunFrame(aunType, port, controlByte, sequence, data) {
    const frame = new Uint8Array(8 + data.length);
    frame[0] = aunType;
    frame[1] = port;
    frame[2] = controlByte;
    frame[3] = 0; // pad
    new DataView(frame.buffer).setUint32(4, sequence, true);
    frame.set(data, 8);
    return frame;
}

function decodeAunFrame(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        aunType: bytes[0],
        port: bytes[1],
        controlByte: bytes[2],
        sequence: view.getUint32(4, true),
        data: bytes.subarray(8),
    };
}

function parseAddress(addressString) {
    const [network, station] = addressString.split(".").map((s) => parseInt(s, 10));
    return { network, station };
}

/**
 * Talks Econet over a WebSocket to a real `aun-filestore` server (see
 * https://github.com/johnhomelan/aun-filestore, WebSocket transport section), so a jsbeeb session
 * can be a first-class station on a real Econet/AUN network instead of the built-in fake file
 * server (LocalFilestoreLink).
 *
 * Wire protocol (JSON text frames, not binary): a `ctrl` message requests a dynamically-allocated
 * network.station address; `pkt` messages carry an 8-byte AUN header (type/port/control/pad/
 * seq) plus data, base64-encoded into the `payload` field so arbitrary binary survives the JSON
 * transport. Requires a server built with the base64 payload fix (payload used to be restricted
 * to bytes <= 0x7F).
 */
export class AunWebSocketTransport {
    constructor(url, { station = null, network = null, onStatusChange = null } = {}) {
        this.url = url;
        this.manualAddress = station !== null ? { station, network: network ?? 0 } : null;
        this.onStatusChange = onStatusChange;
        this.econet = null;
        this.ws = null;
        this.address = null; // {station, network} once known
        this.nextSequence = 1;
        this.pendingAcks = new Map(); // sequence -> onAcked callback
        // Ports we've broadcast or sent an immediate op on: a reply to one of these comes back as an
        // ordinary directed Unicast (aun-filestore always sends type 2 for a non-broadcast
        // destination), but the Beeb is expecting a direct, handshake-free reply on the wire, not a
        // normal scout+ack+body+ack.
        this.pendingReplyPorts = new Set();
        // Resolves once an address is known (or the connection has given up), so callers that need
        // a real station number before the machine boots (e.g. dynamic allocation) can wait on it.
        this.addressReady = new Promise((resolve) => {
            this._resolveAddressReady = resolve;
        });
    }

    /** Wires this transport into an Econet instance and opens the connection. */
    connect(econet) {
        this.econet = econet;
        this._setStatus("connecting");
        this.ws = new WebSocket(this.url);
        this.ws.addEventListener("open", () => this._onOpen());
        this.ws.addEventListener("message", (event) => this._onMessage(event.data));
        this.ws.addEventListener("close", () => {
            this._setStatus("closed");
            this._resolveAddressReady();
        });
        this.ws.addEventListener("error", () => {
            this._setStatus("error");
            this._resolveAddressReady();
        });
    }

    disconnect() {
        this.ws?.close();
        this.ws = null;
        this.address = null;
        this.pendingAcks.clear();
    }

    /** No session state to clear on a BBC reset: the network connection stays up, as real hardware would. */
    reset() {}

    _setStatus(status) {
        this.onStatusChange?.(status);
    }

    _send(message) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
    }

    _onOpen() {
        this._setStatus("open");
        if (this.manualAddress) {
            this.address = this.manualAddress;
            this.econet.setAddress(this.address.station, this.address.network);
            this._resolveAddressReady();
        } else {
            this._send({ type: "ctrl", request: "dynamic_alloction_request", args: [] });
        }
    }

    _onMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        } catch {
            console.log("Econet: discarding malformed WebSocket message");
            return;
        }

        if (message.type === "ctrl") {
            if (typeof message.response !== "string") return;
            this.address = parseAddress(message.response);
            this.econet.setAddress(this.address.station, this.address.network);
            this._setStatus("addressed");
            this._resolveAddressReady();
            return;
        }

        if (message.type !== "pkt" || !this.address) return;
        if (message.dst?.station !== this.address.station || message.dst?.network !== this.address.network) return;
        // aun-filestore sends some pkt messages with a null payload (observed after every Unicast
        // reply); they carry no AUN frame to decode, so skip them rather than let atob(null) coerce
        // to the string "null" and fail confusingly inside decodeAunFrame.
        if (typeof message.payload !== "string") return;

        let frame;
        try {
            frame = decodeAunFrame(base64ToTypedArray(message.payload, Uint8Array));
        } catch (e) {
            console.log(`Econet: discarding pkt with malformed payload: ${e}`);
            return;
        }

        if (frame.aunType === AunType.Ack) {
            const onAcked = this.pendingAcks.get(frame.sequence);
            if (onAcked) {
                this.pendingAcks.delete(frame.sequence);
                onAcked();
            }
            return;
        }

        // Frames are delivered with source network 0, not message.src.network: the Beeb addresses
        // every station this transport reaches as being on its own local network (it sends to e.g.
        // 254.0), and the NFS ROM validates a reply's source address against the address it sent
        // to. The AUN-layer network number (e.g. aun-filestore's own 128) is routing detail that
        // never appears in the network byte on a real local wire.
        if (frame.aunType === AunType.Unicast) {
            const sendAck = () =>
                this._send({
                    type: "pkt",
                    src: { station: this.address.station, network: this.address.network },
                    dst: { station: message.src.station, network: message.src.network },
                    payload: typedArrayToBase64(encodeAunFrame(AunType.Ack, 0, 0, frame.sequence, new Uint8Array(0))),
                });

            if (this.pendingReplyPorts.has(frame.port)) {
                // A reply to our own broadcast/immediate op: no local handshake follows (see
                // deliverInboundImmediateReply), so there's no "Beeb has actually received it" event
                // to defer to. Ack immediately, as aun-filestore's own JsonPacket::buildAck() does.
                sendAck();
                this.econet.deliverInboundImmediateReply(message.src.station, 0, frame.data);
            } else {
                // Deferred until the Beeb's own scout/ack/body/ack handshake for this exact frame
                // finishes (deliverInboundUnicast's onDelivered), not sent as soon as the WebSocket
                // message arrives. Real Econet's four-way handshake is wire-synchronous: the far end
                // cannot start a next transaction until this one's local handshake is done, so a
                // flow-controlled multi-block transfer (GETBYTES/PUTBYTES) never gets ahead of the
                // Beeb. Acking here immediately (as this used to) breaks that: the server races ahead
                // and sends the next block before the ROM's one-shot RXCB for this port is re-armed
                // (see the acorn-nfs ANFS disassembly's note on rx_complete_update_rxcb), so the next
                // scout finds no listener and is silently discarded, stalling the transfer forever.
                this.econet.deliverInboundUnicast(
                    message.src.station,
                    0,
                    frame.controlByte,
                    frame.port,
                    frame.data,
                    sendAck,
                );
            }
            return;
        }

        // A reply to sendImmediate(): aun-filestore's WebSocket handler sends a genuine
        // ImmediateReply-typed frame for this one (unlike a broadcast reply, which it sends as an
        // ordinary Unicast), so it needs its own branch rather than the pendingReplyPorts check above.
        if (frame.aunType === AunType.ImmediateReply) {
            this.econet.deliverInboundImmediateReply(message.src.station, 0, frame.data);
            return;
        }

        // Inbound Broadcast/Reject are not carried over this transport yet.
    }

    // NetworkTransport interface, called by Econet's wire-state-machine ---------------------

    canAcceptScout() {
        return this.ws?.readyState === WebSocket.OPEN && this.address !== null;
    }

    sendUnicast(destStn, destNet, srcStn, srcNet, controlByte, port, data, onAcked) {
        if (this.ws?.readyState !== WebSocket.OPEN || !this.address) return; // Econet's retry timeout covers this

        const sequence = this.nextSequence;
        this.nextSequence = (this.nextSequence + 1) >>> 0;
        this.pendingAcks.set(sequence, onAcked);

        const aunFrame = encodeAunFrame(AunType.Unicast, port, controlByte, sequence, data);
        this._send({
            type: "pkt",
            src: { station: srcStn, network: srcNet },
            dst: { station: destStn, network: destNet },
            payload: typedArrayToBase64(aunFrame),
        });
    }

    /**
     * Broadcasts have no ack/reply handshake on the wire, but still need a fresh sequence number
     * each time: a repeated broadcast (e.g. Econet's own retry of a query nobody answered yet) must
     * look like a distinct packet, not a duplicate of the first attempt the server's dedup window
     * would otherwise silently re-ack without ever re-dispatching to a service for a fresh reply.
     */
    sendBroadcast(srcStn, srcNet, controlByte, port, data) {
        if (this.ws?.readyState !== WebSocket.OPEN || !this.address) return;

        const sequence = this.nextSequence;
        this.nextSequence = (this.nextSequence + 1) >>> 0;
        this.pendingReplyPorts.add(port);
        const aunFrame = encodeAunFrame(AunType.Broadcast, port, controlByte, sequence, data);
        this._send({
            type: "pkt",
            src: { station: srcStn, network: srcNet },
            dst: { station: 0xff, network: 0xff },
            payload: typedArrayToBase64(aunFrame),
        });
    }

    /**
     * Immediate operations (machine peek, halt, continue, etc.) have no scout/ack handshake on the
     * wire either: like a broadcast, the whole frame goes out as a single transmission and any reply
     * comes back directly (routed via pendingReplyPorts, same as sendBroadcast above).
     *
     * controlByte here is the raw Econet frame byte (0x80-0x88: top bit set marks it as an
     * immediate op at the wire/ADLC level), but AUN's control field for an Immediate packet is just
     * the op code itself (aun-filestore's JsonPacket checks iCb==0/1/8 unmasked), so the top bit is
     * stripped before it goes out.
     */
    sendImmediate(destStn, destNet, srcStn, srcNet, controlByte, port, data) {
        if (this.ws?.readyState !== WebSocket.OPEN || !this.address) return;

        const sequence = this.nextSequence;
        this.nextSequence = (this.nextSequence + 1) >>> 0;
        this.pendingReplyPorts.add(port);
        const aunFrame = encodeAunFrame(AunType.Immediate, port, controlByte & 0x7f, sequence, data);
        this._send({
            type: "pkt",
            src: { station: srcStn, network: srcNet },
            dst: { station: destStn, network: destNet },
            payload: typedArrayToBase64(aunFrame),
        });
    }
}
