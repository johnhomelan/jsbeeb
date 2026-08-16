import { ReceiveBlock } from "./econet.js";

// The in-browser fake file server (Filestore) presents itself on the wire as this fixed station.
const LocalFilestoreStationId = 254;
const LocalFilestoreNetwork = 0;

/**
 * Adapts the local, in-browser Filestore (a second, self-contained 6502 emulator running an FS3
 * ROM image, see filestore.js) to the NetworkTransport shape Econet's wire-state-machine expects
 * (canAcceptScout/sendUnicast), while also exposing the receive-block bookkeeping Filestore's own
 * OSWORD &10/&11 handlers need. This is the default, zero-setup transport: no network I/O at all,
 * everything happens as direct in-process calls.
 */
export class LocalFilestoreLink {
    constructor(econet) {
        this.econet = econet;
        this.receiveBlocks = [];
        this.nextReceiveBlockNumber = 1;
    }

    reset() {
        this.receiveBlocks = [];
        this.nextReceiveBlockNumber = 1;
    }

    findReceiveBlock(id) {
        return this.receiveBlocks.find((block) => block.id === id);
    }

    deleteReceiveBlock(id) {
        const pos = this.receiveBlocks.findIndex((block) => block.id === id);
        if (pos >= 0) this.receiveBlocks.splice(pos, 1);
    }

    openReceiveBlock(controlFlag, receivePort, bufferStart, bufferEnd) {
        const id = this.nextReceiveBlockNumber;
        this.receiveBlocks.push(new ReceiveBlock(id, controlFlag, receivePort, bufferStart, bufferEnd));
        this.nextReceiveBlockNumber = (this.nextReceiveBlockNumber + 1) & 0xff;
        if (this.nextReceiveBlockNumber === 0) this.nextReceiveBlockNumber = 1;
        return id;
    }

    /** Is our last transmit to the Beeb still working its way through the handshake? */
    hasPendingTransmit() {
        return this.econet.inboundQueue.length > 0;
    }

    /** Queues a frame from the fake filestore for the Beeb to receive. */
    transmitToStation(controlFlag, port, data) {
        this.econet.deliverInboundUnicast(LocalFilestoreStationId, LocalFilestoreNetwork, controlFlag, port, data);
    }

    // NetworkTransport interface, called by Econet's wire-state-machine ---------------------

    canAcceptScout(destStn, destNet, port) {
        return this.receiveBlocks.some((block) => block.receivePort === port);
    }

    sendUnicast(destStn, destNet, srcStn, srcNet, controlByte, port, data, onAcked) {
        const block = this.receiveBlocks.find((b) => b.receivePort === port);
        if (block) {
            // Mirrors the ADLC-level body layout: four (unused, by this reader) routing bytes
            // ahead of the data, matching what Filestore's OSWORD &11 reads at offset+4.
            block.data.buffer.set(data, 4);
            block.data.bytesInBuffer = 4 + data.length;
            block.stationId = srcStn;
            block.controlFlag = controlByte;
        }
        onAcked();
    }
}
