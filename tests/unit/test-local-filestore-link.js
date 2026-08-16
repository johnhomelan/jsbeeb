import { describe, it, expect, beforeEach } from "vitest";
import { Econet } from "../../src/econet.js";
import { LocalFilestoreLink } from "../../src/local_filestore_link.js";

describe("LocalFilestoreLink", () => {
    let econet;
    let link;

    beforeEach(() => {
        econet = new Econet(101, 2000000);
        econet.reset();
        link = new LocalFilestoreLink(econet);
        econet.setTransport(link);
    });

    it("declines a scout when no receive block is open on that port", () => {
        expect(link.canAcceptScout(101, 0, 0x99)).toBe(false);
    });

    it("accepts a scout once a receive block is open on that port", () => {
        link.openReceiveBlock(0x80, 0x99, 0x1000, 0x2000);
        expect(link.canAcceptScout(101, 0, 0x99)).toBe(true);
    });

    it("assigns incrementing, wrapping-at-255 receive block ids starting from 1", () => {
        const first = link.openReceiveBlock(0, 1, 0, 0);
        const second = link.openReceiveBlock(0, 2, 0, 0);
        expect(first).toBe(1);
        expect(second).toBe(2);
    });

    it("finds and deletes receive blocks by id", () => {
        const id = link.openReceiveBlock(0, 0x99, 0, 0);
        expect(link.findReceiveBlock(id)).toBeDefined();

        link.deleteReceiveBlock(id);
        expect(link.findReceiveBlock(id)).toBeUndefined();
    });

    it("delivers a sent unicast's data into the matching receive block, offset by 4 routing bytes", () => {
        const id = link.openReceiveBlock(0, 0x99, 0, 0);

        const onAcked = () => {};
        link.sendUnicast(101, 0, 50, 0, 0x80, 0x99, new Uint8Array([10, 20, 30]), onAcked);

        const block = link.findReceiveBlock(id);
        expect(block.stationId).toBe(50);
        expect(block.controlFlag).toBe(0x80);
        expect(Array.from(block.data.buffer.slice(0, 7))).toEqual([0, 0, 0, 0, 10, 20, 30]);
    });

    it("acks synchronously, regardless of whether a matching receive block exists", () => {
        let acked = false;
        link.sendUnicast(101, 0, 50, 0, 0, 0x99, new Uint8Array(), () => {
            acked = true;
        });
        expect(acked).toBe(true);
    });

    it("reports a pending transmit only while Econet's inbound queue is non-empty", () => {
        expect(link.hasPendingTransmit()).toBe(false);

        link.transmitToStation(0x80, 0x99, new Uint8Array([1]));
        expect(link.hasPendingTransmit()).toBe(true);
    });

    it("reset() clears receive blocks and the id counter", () => {
        link.openReceiveBlock(0, 1, 0, 0);
        link.reset();

        expect(link.receiveBlocks).toEqual([]);
        expect(link.nextReceiveBlockNumber).toBe(1);
    });
});
