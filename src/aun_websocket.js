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
    }

    /** Wires this transport into an Econet instance and opens the connection. */
    connect(econet) {
        this.econet = econet;
        this._setStatus("connecting");
        this.ws = new WebSocket(this.url);
        this.ws.addEventListener("open", () => this._onOpen());
        this.ws.addEventListener("message", (event) => this._onMessage(event.data));
        this.ws.addEventListener("close", () => this._setStatus("closed"));
        this.ws.addEventListener("error", () => this._setStatus("error"));
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
            return;
        }

        if (message.type !== "pkt" || !this.address) return;
        if (message.dst?.station !== this.address.station || message.dst?.network !== this.address.network) return;

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

        if (frame.aunType === AunType.Unicast) {
            this.econet.deliverInboundUnicast(
                message.src.station,
                message.src.network,
                frame.controlByte,
                frame.port,
                frame.data,
            );
            return;
        }

        // Broadcast/Reject/Immediate/ImmediateReply are not carried over this transport yet.
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
}
