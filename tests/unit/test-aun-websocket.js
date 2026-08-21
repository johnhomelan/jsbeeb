import { describe, it, expect, vi } from "vitest";
import { AunWebSocketTransport } from "../../src/aun_websocket.js";

const OPEN = 1;

function makeFakeSocket() {
    return {
        readyState: OPEN,
        sent: [],
        send(message) {
            this.sent.push(JSON.parse(message));
        },
    };
}

function makeFakeEconet() {
    return {
        setAddress: vi.fn(),
        deliverInboundUnicast: vi.fn(),
    };
}

/** Builds a base64 `pkt` payload independently of the transport's own encoder, for round-trip tests. */
function buildAunPayload(aunType, port, controlByte, sequence, data = []) {
    const bytes = new Uint8Array(8 + data.length);
    bytes[0] = aunType;
    bytes[1] = port;
    bytes[2] = controlByte;
    new DataView(bytes.buffer).setUint32(4, sequence, true);
    bytes.set(data, 8);
    return btoa(String.fromCharCode(...bytes));
}

describe("AunWebSocketTransport", () => {
    describe("connecting", () => {
        it("requests a dynamic address on open when none was configured", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();

            transport._onOpen();

            expect(transport.ws.sent).toEqual([{ type: "ctrl", request: "dynamic_alloction_request", args: [] }]);
            expect(transport.econet.setAddress).not.toHaveBeenCalled();
        });

        it("applies a manually configured address on open instead of requesting one", () => {
            const transport = new AunWebSocketTransport("ws://example/", { station: 5, network: 1 });
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();

            transport._onOpen();

            expect(transport.ws.sent).toEqual([]);
            expect(transport.econet.setAddress).toHaveBeenCalledWith(5, 1);
        });

        it("parses the ctrl response into a network.station address", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();

            transport._onMessage(JSON.stringify({ type: "ctrl", response: "130.7" }));

            expect(transport.econet.setAddress).toHaveBeenCalledWith(7, 130);
            expect(transport.address).toEqual({ network: 130, station: 7 });
        });
    });

    describe("canAcceptScout", () => {
        it("is false until the socket is open and addressed", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            expect(transport.canAcceptScout()).toBe(false);

            transport.ws = makeFakeSocket();
            expect(transport.canAcceptScout()).toBe(false); // no address yet

            transport.address = { station: 1, network: 130 };
            expect(transport.canAcceptScout()).toBe(true);
        });
    });

    describe("sendUnicast", () => {
        it("base64-encodes an 8-byte AUN header plus data as the pkt payload", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();
            transport.address = { station: 1, network: 130 };

            const onAcked = vi.fn();
            transport.sendUnicast(254, 128, 1, 130, 0x80, 0x99, new Uint8Array([10, 20, 30]), onAcked);

            expect(transport.ws.sent).toHaveLength(1);
            const [message] = transport.ws.sent;
            expect(message.type).toBe("pkt");
            expect(message.dst).toEqual({ station: 254, network: 128 });
            expect(message.src).toEqual({ station: 1, network: 130 });

            const payload = Uint8Array.from(atob(message.payload), (c) => c.charCodeAt(0));
            // type=2 (Unicast), port, control, pad=0, sequence=1 (little-endian), then the data.
            expect(Array.from(payload)).toEqual([2, 0x99, 0x80, 0, 1, 0, 0, 0, 10, 20, 30]);
            expect(onAcked).not.toHaveBeenCalled();
        });

        it("does nothing (leaving Econet's retry timeout to cover it) when not connected", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();

            expect(() => transport.sendUnicast(254, 128, 1, 130, 0, 0, new Uint8Array(), vi.fn())).not.toThrow();
        });

        it("calls the matching onAcked callback once an Ack pkt with the same sequence arrives", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();
            transport.address = { station: 1, network: 130 };

            const onAcked = vi.fn();
            transport.sendUnicast(254, 128, 1, 130, 0, 0, new Uint8Array([1]), onAcked);
            const sequence = transport.nextSequence - 1;

            transport._onMessage(
                JSON.stringify({
                    type: "pkt",
                    src: { station: 254, network: 128 },
                    dst: { station: 1, network: 130 },
                    payload: buildAunPayload(3 /* Ack */, 0, 0, sequence),
                }),
            );

            expect(onAcked).toHaveBeenCalledTimes(1);
        });

        it("ignores an Ack for a sequence number it never sent", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();
            transport.address = { station: 1, network: 130 };

            const onAcked = vi.fn();
            transport.sendUnicast(254, 128, 1, 130, 0, 0, new Uint8Array([1]), onAcked);

            transport._onMessage(
                JSON.stringify({
                    type: "pkt",
                    src: { station: 254, network: 128 },
                    dst: { station: 1, network: 130 },
                    payload: buildAunPayload(3 /* Ack */, 0, 0, 99999),
                }),
            );

            expect(onAcked).not.toHaveBeenCalled();
        });
    });

    describe("sendImmediate", () => {
        it("base64-encodes an AUN Immediate frame addressed to the target station", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();
            transport.address = { station: 1, network: 130 };

            transport.sendImmediate(254, 128, 1, 130, 0x88, 0, new Uint8Array([0, 0xdb, 0]));

            expect(transport.ws.sent).toHaveLength(1);
            const [message] = transport.ws.sent;
            expect(message.type).toBe("pkt");
            expect(message.dst).toEqual({ station: 254, network: 128 });
            expect(message.src).toEqual({ station: 1, network: 130 });

            const payload = Uint8Array.from(atob(message.payload), (c) => c.charCodeAt(0));
            // type=5 (Immediate), port=0, control=0x08 (top bit of the raw 0x88 Econet frame byte
            // stripped: AUN's control field for an Immediate packet is just the op code), pad=0,
            // sequence=1 (little-endian), then data.
            expect(Array.from(payload)).toEqual([5, 0, 0x08, 0, 1, 0, 0, 0, 0, 0xdb, 0]);
        });

        it("does nothing when not connected", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();

            expect(() => transport.sendImmediate(254, 128, 1, 130, 0x88, 0, new Uint8Array())).not.toThrow();
        });

        it("routes an ImmediateReply-typed reply to deliverInboundImmediateReply", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.econet.deliverInboundImmediateReply = vi.fn();
            transport.ws = makeFakeSocket();
            transport.address = { station: 1, network: 130 };

            transport.sendImmediate(254, 128, 1, 130, 0x88, 0, new Uint8Array([0, 0xdb, 0]));

            transport._onMessage(
                JSON.stringify({
                    type: "pkt",
                    src: { station: 254, network: 128 },
                    dst: { station: 1, network: 130 },
                    payload: buildAunPayload(6 /* ImmediateReply */, 0, 0, 99, [0x40, 0x66, 1, 25]),
                }),
            );

            // Source network is delivered as 0: the Beeb addressed this station on its own local
            // network, and the ROM validates a reply's source against the address it sent to.
            expect(transport.econet.deliverInboundImmediateReply).toHaveBeenCalledWith(
                254,
                0,
                new Uint8Array([0x40, 0x66, 1, 25]),
            );
            expect(transport.econet.deliverInboundUnicast).not.toHaveBeenCalled();
        });
    });

    describe("receiving", () => {
        it("delivers an inbound Unicast pkt addressed to us to Econet", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();
            transport.address = { station: 1, network: 130 };

            transport._onMessage(
                JSON.stringify({
                    type: "pkt",
                    src: { station: 254, network: 128 },
                    dst: { station: 1, network: 130 },
                    payload: buildAunPayload(2 /* Unicast */, 0x99, 0x80, 42, [1, 2, 3]),
                }),
            );

            // Source network delivered as 0; see the ImmediateReply test above. The 5th argument is
            // the onDelivered callback (see the next test) that fires the AUN ack.
            expect(transport.econet.deliverInboundUnicast).toHaveBeenCalledWith(
                254,
                0,
                0x80,
                0x99,
                new Uint8Array([1, 2, 3]),
                expect.any(Function),
            );
        });

        it("acks an inbound Unicast pkt only once Econet's local handshake for it completes", () => {
            // Mirrors aun-filestore's own JsonPacket::buildAck() in spirit (every Unicast is
            // eventually acked at the transport layer), but not on receipt: acking before the Beeb's
            // own scout/ack/body/ack handshake for this frame finishes would let the server's
            // flow-controlled transfers (GETBYTES, PUTBYTES, ...) race ahead and send the next block
            // before the ROM has re-armed to receive it (real Econet's four-way handshake is
            // wire-synchronous, so this can't happen there). The ack is threaded through as
            // deliverInboundUnicast's onDelivered callback instead, fired by Econet once it's done
            // walking the Beeb through that handshake.
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();
            transport.address = { station: 1, network: 130 };

            transport._onMessage(
                JSON.stringify({
                    type: "pkt",
                    src: { station: 254, network: 128 },
                    dst: { station: 1, network: 130 },
                    payload: buildAunPayload(2 /* Unicast */, 0x99, 0x80, 42, [1, 2, 3]),
                }),
            );

            expect(transport.ws.sent).toHaveLength(0);
            const onDelivered = transport.econet.deliverInboundUnicast.mock.calls[0][5];

            onDelivered();

            expect(transport.ws.sent).toHaveLength(1);
            const [ack] = transport.ws.sent;
            expect(ack.type).toBe("pkt");
            expect(ack.src).toEqual({ station: 1, network: 130 });
            expect(ack.dst).toEqual({ station: 254, network: 128 });

            const payload = Uint8Array.from(atob(ack.payload), (c) => c.charCodeAt(0));
            // type=3 (Ack), port=0, control=0, pad=0, sequence=42 (little-endian, echoed from the
            // packet being acked), no data.
            expect(Array.from(payload)).toEqual([3, 0, 0, 0, 42, 0, 0, 0]);
        });

        it("ignores a pkt addressed to a different station", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();
            transport.address = { station: 1, network: 130 };

            transport._onMessage(
                JSON.stringify({
                    type: "pkt",
                    src: { station: 254, network: 128 },
                    dst: { station: 2, network: 130 },
                    payload: buildAunPayload(2, 0, 0, 1),
                }),
            );

            expect(transport.econet.deliverInboundUnicast).not.toHaveBeenCalled();
        });

        it("discards malformed JSON without throwing", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();

            expect(() => transport._onMessage("not-json{{{")).not.toThrow();
            expect(transport.econet.deliverInboundUnicast).not.toHaveBeenCalled();
        });

        it("discards a pkt with a non-base64 payload without throwing", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();
            transport.address = { station: 1, network: 130 };

            expect(() =>
                transport._onMessage(
                    JSON.stringify({
                        type: "pkt",
                        src: { station: 254, network: 128 },
                        dst: { station: 1, network: 130 },
                        payload: "not valid base64!!!",
                    }),
                ),
            ).not.toThrow();
            expect(transport.econet.deliverInboundUnicast).not.toHaveBeenCalled();
        });

        it("discards a pkt with a null payload without throwing", () => {
            const transport = new AunWebSocketTransport("ws://example/", {});
            transport.econet = makeFakeEconet();
            transport.ws = makeFakeSocket();
            transport.address = { station: 1, network: 130 };

            expect(() =>
                transport._onMessage(
                    JSON.stringify({
                        type: "pkt",
                        src: { station: 254, network: 128 },
                        dst: { station: 1, network: 130 },
                        payload: null,
                    }),
                ),
            ).not.toThrow();
            expect(transport.econet.deliverInboundUnicast).not.toHaveBeenCalled();
        });
    });
});
