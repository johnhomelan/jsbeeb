define([], function () {
    "use strict";

    function Econet(cpu, cmos) {
	    this.cpu = cpu;
	    this.cmos = cmos;
	    this.reset();
	    this.enabled = true;
	    this.NMIEnabled = false;
	    this.econetStation = new Uint8Array(1);
	    self.NMI = function () {
		    cpu.NMI(self.status & 8);
	    };

	    if(cpu.model.isMaster){
		    this.cmos.write(0xe, this.getStationNum());
	    }

    }

    Econet.prototype.reset = function () {
	    this.control1 = 192;
	    this.control2 = 0;
	    this.control3 = 0;
	    this.control4 = 0;

	    this.status1=0;
	    this.status2=0;
	    this.sr2pse=0;

	    this.rxfptr=0;
	    this.rxapr=0;
	    this.rxffc=0;
	    this.txfptr=0;
	    this.txftl=0;

	    this.iTxBufSize=2048;
	    this.iRxBufSize=2048;

	    this.txfifo = new Uint8Array(3);
	    this.rxfifo = new Uint8Array(3);
	    this.Econetrxbuff = new Uint8Array(this.iRxBufSize);
	    this.Econettxbuff = new Uint8Array(this.iTxBufSize);

            this.EconetRxReadPointer = 0;
            this.EconetRxBytesInBuffer = 0;
            this.EconetTxWritePointer = 0;
            this.EconetTxBytesInBuffer = 0;

	    this.ReceiverSocketsOpen = 0;

    };

    Econet.prototype.polltime = function (cycles)
    {
	//Save the flags
	var tmp_status1 = this.status1;
	var tmp_status2 = this.status2;

        // okie dokie.  This is where the brunt of the ADLC emulation & network handling will happen.

        // look for control bit changes and take appropriate action

        // CR1b0 - Address Control - only used to select between register 2/3/4
        //              no action needed here
        // CR1b1 - RIE - Receiver Interrupt Enable - Flag to allow receiver section to create interrupt.
        //              no action needed here
        // CR1b2 - TIE - Transmitter Interrupt Enable - ditto
        //              no action needed here
        // CR1b3 - RDSR mode. When set, interrupts on received data are inhibited.
        //              unsupported - no action needed here
        // CR1b4 - TDSR mode. When set, interrupts on trasmit data are inhibited.
        //              unsupported - no action needed here
        // CR1b5 - Discontinue - when set, discontinue reception of incoming data.
        //          automatically reset this when reach the end of current frame in progress
        //              automatically reset when frame aborted bvy receiving an abort flag, or DCD fails.
        if (this.control1 & 32) {
                this.EconetRxReadPointer =0;
                this.EconetRxBytesInBuffer = 0;
                this.rxfptr = 0;
               	this.rxap = 0;
                this.rxffc = 0;
                this.control1 &= ~32;   // reset flag
        }
        // CR1b6 - RxRs - Receiver reset. set by cpu or when reset line goes low. 
        //              all receive operations blocked (bar dcd monitoring) when this is set. 
        //              see CR2b5 
        // CR1b7 - TxRS - Transmitter reset. set by cpu or when reset line goes low. 
        //              all transmit operations blocked (bar cts monitoring) when this is set. 
        //              no action needed here; watch this bit elsewhere to inhibit actions 
                         
        // ----------------------- 
        // CR2b0 - PSE - priotitised status enable - adjusts how status bits show up. 
        //         See sr2pse and code in status section 
        // CR2b1 - 2byte/1byte mode.  set to indicate 2 byte mode. see trda status bit. 
        // CR2b2 - Flag/Mark idle select. What is transmitted when tx idle. ignored here as not needed 
        // CR2b3 - FC/TDRA mode - does status bit SR1b6 indicate 1=frame complete,  
        //      0=tx data reg available. 1=frame tx complete.  see tdra status bit 
        // CR2b4 - TxLast - byte just put into fifo was the last byte of a packet. 
        if (this.control2 & 16) {                                       // TxLast set 
                this.txftl |= 1;                                        // set b0 - flag for fifo[0] 
                this.control2 &= ~16;                                   // clear flag. 
        } 

        // CR2b5 - CLR RxST - Clear Receiver Status - reset status bits
        if ((this.control2 & 32) || (this.control1 & 64)) {     // or rxreset
                this.control2 &= ~32;                                   // clear this bit
                this.status1 &= ~10;                                    // clear sr2rq, FD
                this.status2 &= ~126;                                   // clear FV, RxIdle, RxAbt, Err, OVRN, DCD

                if (this.control2 & 1 && this.sr2pse) { // PSE active?
                        this.sr2pse++;                                          // Advance PSE to next priority
                        if (this.sr2pse > 4)
                                this.sr2pse = 0;
                } else {
                        this.sr2pse = 0;
                }

                var sr1b2cause = 0;                                                 // clear cause of sr2b1 going up
                if (this.control1 & 64) {                               // rx reset,clear buffers.
                        this.EconetRxReadPointer =0;
                        this.EconetRxBytesInBuffer = 0;
                        this.rxfptr = 0;
                        this.rxap = 0;
                        this.rxffc = 0;
                        this.sr2pse = 0;
                }
        }
        // CR2b6 - CLT TxST - Clear Transmitter Status - reset status bits
        if ((this.control2 & 64) || (this.control1 & 128)) {    // or txreset
                this.control2 &= ~64;                                   // clear this bit
                this.status1 &= ~0x70;                                  // clear TXU , cts, TDRA/FC
                if (this.cts) {
                        this.status1 |= 16;                                     //cts follows signal, reset high again
                        tmp_status1 |= 16;                         // don't trigger another interrupt instantly
                }
                if (this.control1 & 128) {                              // tx reset,clear buffers.
                        this.EconetTxWritePointer =0;
                        this.EconetTxBytesInBuffer = 0;
                        this.txfptr = 0;
                        this.txftl = 0;
                }
        }
        // CR2b7 - RTS control - looks after RTS output line. ignored here.
        //              but used in CTS logic
        // RTS gates TXD onto the econet bus. if not zero, no tx reaches it,
        // in the B+, RTS substitutes for the collision detection circuit.

        // -----------------------
        // CR3 seems always to be all zero while debugging emulation.
        // CR3b0 - LCF - Logical Control Field Select. if zero, no control fields in frame, ignored.
        // CR3b1 - CEX - Extend Control Field Select - when set, control field is 16 bits. ignored.
        // CR3b2 - AEX - When set, address will be two bytes (unless first byte is zero). ignored here.
        // CR3b3 - 01/11 idle - idle transmission mode - ignored here,.
        // CR3b4 - FDSE - flag detect status enable.  when set, then FD (SR1b3) + interrupr indicated a flag
        //                              has been received. I don't think we use this mode, so ignoring it.
        // CR3b5 - Loop - Loop mode. Not used.
        // CR3b6 - GAP/TST - sets test loopback mode (when not in Loop operation mode.) ignored.
        // CR3b7 - LOC/DTR - (when not in loop mode) controls DTR pin directly. pin not used in a BBC B

        // -----------------------
        // CR4b0 - FF/F - when clear, re-used the Flag at end of one packet as start of next packet. ignored.
        // CR4b1,2 - TX word length. 11=8 bits. BBC uses 8 bits so ignore flags and assume 8 bits throughout
        // CR4b3,4 - RX word length. 11=8 bits. BBC uses 8 bits so ignore flags and assume 8 bits throughout
        // CR4b5 - TransmitABT - Abort Transmission.  Once abort starts, bit is cleared.
        if (this.control4 & 32) {               // ABORT
                this.txfptr = 0;                        //      reset fifo
                this.txftl = 0;                         //      reset fifo flags
                this.EconetTxWritePointer = 0;
                this.EconetTxBytesInBuffer = 0;
                this.control4 &= ~32;           // reset flag.
        }
	
        // CR4b6 - ABTex - extend abort - adjust way the abort flag is sent.  ignore,
        //      can affect timing of RTS output line (and thus CTS input) still ignored.
        // CR4b7 - NRZI/NRZ - invert data encoding on wire. ignore.

                if (!(this.control1 & 128)) {           // tx reset off
                        if (this.txfptr) {                              // there is data is in tx fifo
                                var TXlast =false;
                                if (this.txftl & powers[this.txfptr-1]) TXlast=true;    // TxLast set
                                if (this.EconetTxWritePointer + 1 >this.iTxBufSize || // overflow IP buffer
                                                (this.txfptr >4 )) {                            // overflowed fifo
                                        this.status1 |= 32;                                             // set tx underrun flag
                                        this.EconetTxWritePointer = 0;                               // wipe buffer
                                        EconetTxBytesInBuffer = 0;
                                        this.txfptr = 0;
                                        this.txftl = 0;
                                } else {
					--this.txfptr;
                                        this.Econettxbuff[this.EconetTxWritePointer] = this.txfifo[this.txfptr];
                                        this.EconetTxWritePointer++;
                                }
				if (TXlast) {	
					var i = 0;
					do {
						// Send to all stations except ourselves
						if (this.network[i].station != this.EconetStationNumber) {
//							RecvAddr.sin_family = AF_INET;
//							RecvAddr.sin_port = htons(network[i].port);
//							RecvAddr.sin_addr.s_addr = network[i].inet_addr;
//
							// Send a datagram to the receiver
//->							if (DebugEnabled) {
//--								sprintf(info, "Econet: TXLast set - Send %d byte packet to %02x %02x (%08X :%u)",
//--										EconetTxWritePointer,
//--										(unsigned int)(Econettxbuff[1]), (unsigned int)Econettxbuff[0],
//--										(unsigned int)network[i].inet_addr, (unsigned int)network[i].port);
//--								DebugDisplayTrace(DEBUG_ECONET, true, info);
//--								sprintf(info, "Econet: Packet data:");
//--								for (unsigned int i = 0; i < EconetTxWritePointer; ++i) {
//--									sprintf(info+strlen(info), " %02X", Econettxbuff[i]);
//--								}
//--								DebugDisplayTrace(DEBUG_ECONET, true, info);
//--							}
//++

//							sprintf(info, "Packet data:");
//							for(var x=0;x<this.EconetTxWritePointer;++x){
//								sprintf(info+strlen(info)," %02X"
//								 , this.Econettxbuff[x]);
//							}
//<-

//							if (sendto(SendSocket, (char*)Econettxbuff
//							 , EconetTxWritePointer, 0, (struct sockaddr*) &RecvAddr
//							 , sizeof(RecvAddr)) == -1) {
//								sprintf(info,"Econet: Failed to send packet to"
//								 " %02x %02x (%08X :%u)"
//								, (unsigned int)(Econettxbuff[1])
//								, (unsigned int)Econettxbuff[0]
//								, (unsigned int)network[i].inet_addr
//								, (unsigned int)network[i].port);
//								EconetError(info);
//							}
//<-
						};
						i++;
					} while (this.network[i].station != 0);

					// Sending packet will mean peer goes into flag fill while
					// it deals with it
					var FlagFillActive = true;
					////SetTrigger(EconetFlagFillTimeout, EconetFlagFillTimeoutTrigger);

					// When the application is finished sending, close the socket.
					//	    closesocket(SendSocket);
					this.EconetTxWritePointer = 0;					// wipe buffer
					this.EconetTxBytesInBuffer = 0;					
				}	
			}	
		}

		// Receive data
		if (!(this.control1 & 64)) {		// rx reset off
			if (this.EconetRxReadPointer < this.EconetRxBytesInBuffer) {
				// something waiting to be given to the processor
				if (this.rxfptr<3 )	{		// space in fifo
					qDEBUG("Econet poll: Time to give another byte to the beeb.");
//<-
					this.rxfifo[2] = this.rxfifo[1];
					this.rxfifo[1] = this.rxfifo[0];
					this.rxfifo[0] = this.Econetrxbuff[this.EconetRxReadPointer];
					this.rxfptr++;
					this.rxffc = (this.rxffc <<1) & 7;
					this.rxap = (this.rxap <<1) & 7;
					if (this.EconetRxReadPointer == 0)
						this.rxap |= 1; 			// todo - 2 bytes? adr extention mode
					this.EconetRxReadPointer++;
					if (this.EconetRxReadPointer >= this.EconetRxBytesInBuffer)  { // that was last byte!
						this.rxffc |= 1;			// set FV flag (this was last byte of frame)
						this.EconetRxReadPointer = 0;    // Reset read for next packet
						this.EconetRxBytesInBuffer = 0;
					}		
				}
			}
			if (this.rxfptr == 0)  {
				// still nothing in buffers (and thus nothing in Econetrx buffer)
				this.control1 &= ~32;		// reset discontinue flag

				// wait for cpu to clear FV flag from last frame received
				if (!(this.status2 & 2)) {
					// Try and get another packet from network
					// Check if packet is waiting without blocking
/*  					var RetVal;
					fd_set RdFds;
					timeval TmOut = {0,0};
					FD_ZERO(&RdFds);
					FD_SET(ListenSocket, &RdFds);
					RetVal = select(ListenSocket + 1, &RdFds, NULL, NULL, &TmOut);
					if (RetVal > 0)
					{
						// Read the packet
						RetVal = recv(ListenSocket, (char *)Econetrxbuff, this.iRxBufSize, 0);
  						if (RetVal > 0) {
//->							if (DebugEnabled) {
//--								sprintf (info, "EconetPoll: Packet received. %u bytes", (int)RetVal);
//--								DebugDisplayTrace(DEBUG_ECONET, true, info);
//--								sprintf (info, "EconetPoll: Packet data:");
//--								for (int i = 0; i < RetVal; ++i) {
//--									sprintf(info+strlen(info), " %02X", Econetrxbuff[i]);
//--								}
//--								DebugDisplayTrace(DEBUG_ECONET, true, info);
//--							}
//++
							pDEBUG(dL"Packet received. %u bytes.", dR, (int)RetVal);
							sprintf (info, "EconetPoll: Packet data:");
							for (int i = 0; i < RetVal; ++i) {
								sprintf(info+strlen(info), " %02X"
								 , this.Econetrxbuff[i]);
							}
							pDEBUG(dL"%s", dR, info);
//<-
							EconetRxReadPointer =0;
							EconetRxBytesInBuffer = RetVal;

							if (this.Econetrxbuff[0] == EconetStationNumber) {
								// Peer sent us packet - no longer in flag fill
								FlagFillActive = false;
//--								if (DebugEnabled) DebugDisplayTrace(DEBUG_ECONET, true,
//--													"Econet: FlagFill reset");
							} else {
								// Two other stations communicating - assume one of them will flag fill
								FlagFillActive = true;
								//SetTrigger(EconetFlagFillTimeout, EconetFlagFillTimeoutTrigger);
//--								if (DebugEnabled) DebugDisplayTrace(DEBUG_ECONET, true,
//--													"Econet: FlagFill reset");
							} else {
								// Two other stations communicating - assume one of them will flag fill
								FlagFillActive = true;
								//SetTrigger(EconetFlagFillTimeout, EconetFlagFillTimeoutTrigger);
//--								if (DebugEnabled) DebugDisplayTrace(DEBUG_ECONET, true,
//--													"Econet: FlagFill set - other station comms");
//+>
								qDEBUG("FlagFill set - other station comms");
//<+
							}


//->						} else if (RetVal == SOCKET_ERROR) {
//++
						} else if (RetVal == -1){
							EconetError("Econet: Failed to receive packet");
						}
//<-


//++
					} else if (RetVal == -1) {
//<-
						EconetError("Econet: Failed to check for new packet");
					}
					*/
				} 
			}
		}

		// Update idle status
		if (!(this.control1 & 0x40)				// not rxreset
			&& !this.rxfptr						// nothing in fifo
			&& !(this.status2 & 2)              // no FV
			&& (this.EconetRxBytesInBuffer ==0)) {	// nothing in ip buffer
			this.idle = true;
		} else {
			this.idle = false;
		}

		//----------------------------------------------------------------------------------
		// how long before we come back in here?
	    //SetTrigger(TIMEBETWEENBYTES,EconetTrigger);

	// Reset pseudo flag fill?
//	if (EconetFlagFillTimeoutTrigger<=TotalCycles && FlagFillActive) {
//		FlagFillActive = false;
//	}	


	//--------------------------------------------------------------------------------------------
	// Status bits need changing?

	// SR1b0 - RDA - received data available. 
	if (!(this.control1 & 64)) { 		// rx reset off
		if ((this.rxfptr && !(this.control2 & 2))			// 1 byte mode
		    || ((this.rxfptr > 1) && (this.control2 & 2)))	// 2 byte mode
		{
			this.status1 |=  1;		// set RDA copy
			this.status2 |=  128;
		} else {
			this.status1 &= ~1;
			this.status2 &= ~128;
		} 
	}
	// SR1b1 - S2RQ - set after SR2, see below
	// SR1b2 - LOOP - set if in loop mode. not supported in this emulation,
	// SR1b3 - FD - Flag detected. Hmm.
	// SR1b4 - CTS - set by ~CTS line going up, and causes IRQ if enabled.
	//				only cleared by cpu. 
	//			~CTS is a NAND of DCD(clock present)(high if valid)
	//			 &  collission detection!
	//			i.e. it's low (thus clear to send) when we have both DCD(clock) 
//          present AND no collision on line and no collision.
	//          cts will ALSO be high if there is no cable!
	//		we will only bother checking against DCD here as can't have collisions.
	//		but nfs then loops waiting for CTS high!	
	//  on the B+ there is (by default) no collission detection circuitary. instead S29
	// links RTS in it's place, thus CTS is a NAND of not RTS & not DCD
	// i.e. cts = ! ( !rts && !dcd ) all signals are active low.
	// there is a delay on rts going high after cr2b7=0 - ignore this for now.
	// cr2b7 = 1 means RTS low means not rts high means cts low
	// sockets true means dcd low means not dcd high means cts low
	// doing it this way finally works !!  great :-) :-)

	if (this.ReceiverSocketsOpen && (this.control2 & 128) ) {	// clock + RTS
		this.cts = false;
		this.status1 &= ~16;
	} else {
		this.cts = true;
	}

	// and then set the status bit if the line is high! (status bit stays
	// up until cpu tries to clear it) (& still stays up if cts line still high)

	if (!(this.control1 && 128) && this.cts) {
		this.status1 |= 16;		// set CTS now
	}

	// SR1b5 - TXU - Tx Underrun.
	if (this.txfptr>4) {		// probably not needed
		this.status1 |= 32;
		this.txfptr = 4;
	}

	// SR1b6 TDRA flag - another complicated derivation
	if (!(this.control1 & 128)) {		// not txreset
		if (!(this.control2 & 8)) {		// tdra mode
			if (   (   ((this.txfptr < 3) && !(this.control2 & 2)) // space in fifo?
			        || ((this.txfptr < 2) && (this.control2 & 2))) // space in fifo?
			    && (!(this.status1 & 16))		// clear to send is ok
			    && (!(this.status2 & 32)) ) {	// DTR not high
				this.status1 |= 64;				// set Tx Reg Data Available flag.
			} else {
				this.status1 &= ~64;			// clear Tx Reg Data Available flag.
			}
		} else {		// FC mode
			if (!(this.txfptr)) {			// nothing in fifo
				this.status1 |= 64;			// set Tx Reg Data Available flag.
			} else {
				this.status1 &= ~64;		// clear Tx Reg Data Available flag.
			}
		}
	}
	// SR1b7 IRQ flag - see below

	// SR2b0 - AP - Address present 
	if (!(this.control1  & 64)) {				// not rxreset
		if (this.rxfptr &&
			(this.rxap & (powers[this.rxfptr-1]))) {		// ap bits set on fifo
			this.status2 |= 1;
		} else {
			this.status2 &= ~1;
		}
		// SR2b1 - FV -Frame Valid - set in rx - only reset by ClearRx or RxReset
		if (this.rxfptr &&
			(this.rxffc & (powers[this.rxfptr-1]))) {
			this.status2 |= 2;
		}
		// SR2b2 - Inactive Idle Received - sets irq!
		if (this.idle && !FlagFillActive) {
			this.status2 |= 4;
		} else {
			this.status2 &= ~4;
		}
	}
	// SR2b3 - RxAbort - Abort received - set in rx routines above
	// SR2b4 - Error during reception - set if error flaged in rx routine.
	// SR2b5 - DCD
	if (!this.ReceiverSocketsOpen) {			// is line down?
		this.status2 |= 32;				// flag error
	} else {
		this.status2 &= ~32;
	}
	// SR2b6 - OVRN -receipt overrun. probably not needed 
	if (this.rxfptr>4) {
		this.status2 |= 64;
		this.rxfptr = 4;
	}
	// SR2b7 - RDA. As per SR1b0 - set above.
	// Handle PSE - only for SR2 Rx bits at the moment - others todo
	var sr2psetemp = this.sr2pse;
	if (this.control2 & 1) {
		if ((this.sr2pse <= 1) && (this.status2 & 0x7A)) {	// ERR, FV, DCD, OVRN, ABT
			this.sr2pse = 1;
			this.status2 &= ~0x85;
		} else if ((this.sr2pse <= 2) && (this.status2 & 0x04)) { // Idle
			this.sr2pse = 2;
			this.status2 &= ~0x81;
		} else if ((this.sr2pse <= 3) && (this.status2 & 0x01)) { // AP
			this.sr2pse = 3;
			this.status2 &= ~0x80;
		} else if (this.status2 & 0x80) {					// RDA
			this.sr2pse = 4;
			this.status2 &= ~0x02;
		} else {
			this.sr2pse = 0;				// No relevant bits set
		}

		// Set SR1 RDA copy
		if (this.status2 & 0x80)
			this.status1 |= 1;
		else
			this.status1 &= ~1;

	} else {								// PSE inactive
		this.sr2pse = 0;
	}
	// Do we need to flag an interrupt?
	if (this.status1 != tmp_status1 || this.status2 != tmp_status2) { // something changed
		var tempcause;
		var temp2;

		// SR1b1 - S2RQ - Status2 request. New bit set in S2?
		tempcause = ((this.status2 ^ tmp_status2) & this.status2) & ~128;

		if (!(this.control1 & 2))	{	// RIE not set,
			tempcause = 0;
		}

		if (tempcause) { //something got set
			this.status1 |= 2;
			sr1b2cause = sr1b2cause | tempcause;
		} else if (!(this.status2 & sr1b2cause)) { //cause has gone
			this.status1 &= ~2;
			sr1b2cause = 0;
		}

		// New bit set in S1?
		tempcause = ((this.status1 ^ tmp_status1) & this.status1) & ~128;

		if (!(this.control1 & 2))	{	// RIE not set,
			tempcause = tempcause & ~11;
		}
		if (!(this.control1 & 4))	{	// TIE not set,
			tempcause = tempcause & ~0x70;
		}
		
		var interruptnow;
		var irqcause = 0;
		if (tempcause) { //something got set
			interruptnow = true;
			irqcause = irqcause | tempcause;	// remember which bit went high to flag irq
			// SR1b7 IRQ flag
			this.status1 |= 128;
		}

		// Bit cleared in S1?
		temp2 = ((this.status1 ^ tmp_status1) & tmp_status1) & ~128;
		if (temp2) {		// something went off
			irqcause = irqcause & ~temp2;	// clear flags that went off
			if (irqcause == 0) {	// all flag gone off now
				// clear irq status bit when cause has gone.
				this.status1 &= ~128;
			} else {
				// interrupt again because still have flags set
				if (this.control2 & 1) {
					interruptnow = true;
				}
			}
		}
	}

	return (interruptnow);	// flag NMI if necessary. see also INTON flag as
							// this can cause a delayed interrupt.(beebmem.cpp)

    };

    Econet.prototype.read = function (addr) {
	    if(!this.enabled){
		    return 0xfe;
	    }
	    addr = addr & 3; //Only want to deal with the last 2 bits of the address 
	    switch(addr){
		    case 0:
			return this.status1;
			break;
		    case 1:
			return this.status2;
			break;
		    default:
			    if (((this.control1 & 64)===0) && this.rxfptr) {
				--this.rxfptr;
				return (this.rxfifo[this.rxfptr]);
		            }else {
				return 0;
		            }
			    break;
	    }
    };

    Econet.prototype.write = function (addr, val) {
	    addr = addr & 3; //Only want to deal with the last 2 bits of the address 
	    console.log("Econet write "+addr+" "+val);

	    switch(addr){
		    case 0:
			this.control1 = val;
			break;
		    case 1:
			if(!(this.control1 & 1)){ 
				this.control2 = val; //AC = 0
			}else if(this.control1 & 1){
				this.control3 = val; //AC = 1
			}
			break;
		    case 3:
			if(this.control1 & 1){
				this.control4 = val; //AC = 1
			}
			break;
	    }
	    if(addr==2 || addr==3){
		    if((this.control1 & 128)===0){
			this.txfifo[2] = this.txfifo[1];
                        this.txfifo[1] = this.txfifo[0];
                        this.txfifo[0] = val;
                        this.txfptr++;
                        this.txftl = this.txftl <<1;
			if (addr == 3){
				this.control2 |= 16; // set txlast control flag ourself
			}
	            }
	    }
    };
	
    Econet.prototype.getStationNum = function() {
	    return this.econetStation[1];
    };

    Econet.prototype.isNMIEnabled = function()
    {
	    return this.NMIEnabled;
    };

    Econet.prototype.enableNMI = function() {
	    this.NMIEnabled = true;
    };

    Econet.prototype.disableNMI = function() {
	    this.NMIEnabled = false;
    };

    Econet.prototype.delayedNMIAssert = function() {
    };

    Econet.prototype.onComplete = function () {
    };
    return Econet;
});
