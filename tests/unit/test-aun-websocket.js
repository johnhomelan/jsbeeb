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

            expect(transport.econet.deliverInboundUnicast).toHaveBeenCalledWith(
                254,
                128,
                0x80,
                0x99,
                new Uint8Array([1, 2, 3]),
            );
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
    });
});
