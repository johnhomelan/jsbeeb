import { describe, it, expect, beforeEach } from "vitest";
import { Econet } from "../../src/econet.js";

function makeFakeTransport() {
    return {
        accepted: [],
        sent: [],
        canAcceptScout(destStn, destNet, port) {
            this.accepted.push({ destStn, destNet, port });
            return true;
        },
        sendUnicast(destStn, destNet, srcStn, srcNet, controlByte, port, data, onAcked) {
            this.sent.push({ destStn, destNet, srcStn, srcNet, controlByte, port, data: Array.from(data) });
            onAcked();
        },
    };
}

// Drives a whole ADLC frame through the tx fifo one byte at a time, exactly as the real MOS
// driver would: every byte but the last goes to the data register, the last goes to the
// "last data" register (which is what actually marks TxLast and completes the frame).
function sendFrame(econet, bytes) {
    for (let i = 0; i < bytes.length; i++) {
        econet.writeRegister(i === bytes.length - 1 ? 3 : 2, bytes[i]);
        // updateRegisters() is what turns the CR2 TxLast bit into the internal txftl flag
        // transmit() checks; polltime() always calls it first, so the driver relies on it.
        econet.updateRegisters();
        econet.transmit();
    }
}

describe("Econet", () => {
    const cyclesPerSecond = 2000000;
    let econet;

    beforeEach(() => {
        econet = new Econet(101, cyclesPerSecond);
        econet.reset();
        econet.writeRegister(0, 0); // clear CR1's RxReset/TxReset, as the OS driver does at boot
    });

    describe("outbound (Beeb -> transport)", () => {
        it("asks the transport whether to accept a scout, addressed as the Beeb sent it", () => {
            const transport = makeFakeTransport();
            econet.setTransport(transport);

            sendFrame(econet, [50, 0, 101, 0, 0x80, 0x99]); // scout: dest=50.0, control=0x80, port=0x99

            expect(transport.accepted).toEqual([{ destStn: 50, destNet: 0, port: 0x99 }]);
            expect(econet.wireState).toBe(econet.FWH_TX_Scout_Sent);
        });

        it("stays idle if the transport declines the scout", () => {
            const transport = makeFakeTransport();
            transport.canAcceptScout = () => false;
            econet.setTransport(transport);

            sendFrame(econet, [50, 0, 101, 0, 0x80, 0x99]);

            expect(econet.wireState).toBe(econet.FWH_Idle);
        });

        it("stays idle with no transport plugged in", () => {
            sendFrame(econet, [50, 0, 101, 0, 0x80, 0x99]);
            expect(econet.wireState).toBe(econet.FWH_Idle);
        });

        it("hands the body to the transport with the routing captured from the scout", () => {
            const transport = makeFakeTransport();
            econet.setTransport(transport);

            sendFrame(econet, [50, 0, 101, 0, 0x80, 0x99]); // scout
            sendFrame(econet, [0, 0, 0, 0, 1, 2, 3]); // body: 4 routing bytes (unused) + data

            expect(transport.sent).toEqual([
                { destStn: 50, destNet: 0, srcStn: 101, srcNet: 0, controlByte: 0x80, port: 0x99, data: [1, 2, 3] },
            ]);
            expect(econet.wireState).toBe(econet.FWH_Idle);
        });

        it("keeps offering the Beeb a fallback ack if the transport never confirms the body", () => {
            const transport = makeFakeTransport();
            transport.sendUnicast = () => {}; // never calls onAcked
            econet.setTransport(transport);

            sendFrame(econet, [50, 0, 101, 0, 0x80, 0x99]);
            sendFrame(econet, [0, 0, 0, 0, 1, 2]);
            expect(econet.wireState).toBe(econet.FWH_TX_Scout_Sent);

            econet.polltime(cyclesPerSecond); // well past the 0.5s retry timeout

            // Still waiting on the far end: the retry only refreshes the fallback ack the Beeb
            // can see, it doesn't force the handshake to complete on its own.
            expect(econet.wireState).toBe(econet.FWH_TX_Scout_Sent);
            expect(Array.from(econet.beebRx.buffer.slice(0, 4))).toEqual([101, 0, 50, 0]);
        });
    });

    describe("inbound (transport -> Beeb)", () => {
        it("presents an inbound unicast as a scout addressed from the real sender", () => {
            econet.setAddress(101, 0);
            econet.deliverInboundUnicast(50, 0, 0x80, 0x99, new Uint8Array([1, 2, 3]));

            econet.polltime(200);

            expect(Array.from(econet.beebRx.buffer.slice(0, 6))).toEqual([101, 0, 50, 0, 0x80, 0x99]);
            expect(econet.wireState).toBe(econet.FWH_RX_Scout_Received);
        });

        it("walks the scout-ack through to delivering the body and the final ack", () => {
            econet.setAddress(101, 0);
            econet.deliverInboundUnicast(50, 0, 0x80, 0x99, new Uint8Array([1, 2, 3]));
            econet.polltime(200);
            expect(econet.wireState).toBe(econet.FWH_RX_Scout_Received);

            sendFrame(econet, [50, 0, 101, 0]); // the Beeb's 4-byte scout ack
            expect(econet.wireState).toBe(econet.FWH_RX_ScoutAck_Received);

            econet.polltime(200);
            expect(econet.wireState).toBe(econet.FWH_RX_Body_Received);
            expect(Array.from(econet.beebRx.buffer.slice(0, 7))).toEqual([101, 0, 50, 0, 1, 2, 3]);

            sendFrame(econet, [50, 0, 101, 0]); // the Beeb's final ack
            expect(econet.wireState).toBe(econet.FWH_Idle);
            expect(econet.inboundQueue).toHaveLength(0);
        });
    });

    describe("setAddress", () => {
        it("updates the station and network used to address future frames", () => {
            econet.setAddress(130, 1);
            expect(econet.stationId).toBe(130);
            expect(econet.network).toBe(1);
        });
    });
});
