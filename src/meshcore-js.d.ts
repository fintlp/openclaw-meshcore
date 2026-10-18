declare module "@liamcottle/meshcore.js" {
  import type { EventEmitter } from "node:events";

  export const Constants: {
    PushCodes: {
      SendConfirmed: 0x82;
      Advert: 0x80;
      NewAdvert: 0x8a;
      // other push codes may be added as needed
    };
    ResponseCodes: {
      Ok: 0;
      Err: 1;
      ContactsStart: 2;
      Contact: 3;
      EndOfContacts: 4;
      SelfInfo: 5;
      Sent: 6;
      ContactMsgRecv: 7;
      ChannelMsgRecv: 8;
      CurrTime: 9;
      NoMoreMessages: 10;
      ExportContact: 11;
      BatteryVoltage: 12;
      DeviceInfo: 13;
      PrivateKey: 14;
      Disabled: 15;
      ContactMsgRecvV3: 16;
      ChannelMsgRecvV3: 17;
      ChannelInfo: 18;
      SignStart: 19;
      Signature: 20;
      Stats: 24;
      ChannelDataRecv: 27;
    };
  };

  export type TCPConnectionEventMap = {
    connected: () => void;
    disconnected: () => void;
    error: (error: Error) => void;
    rx: (frame: Uint8Array) => void;
    tx: (frame: Uint8Array) => void;
    // Response events are emitted by numeric code (Constants.ResponseCodes),
    // not by friendly name. Keys match the numeric constants so typed
    // subscribers that use Constants.ResponseCodes.* resolve correctly.
    0: () => void;
    1: (error: Record<string, unknown>) => void;
    3: (contact: Record<string, unknown>) => void;
    4: () => void;
    5: (info: Record<string, unknown>) => void;
    6: (response: Record<string, unknown>) => void;
    7: (message: Record<string, unknown>) => void;
    8: (message: Record<string, unknown>) => void;
    12: (info: Record<string, unknown>) => void;
    13: (info: Record<string, unknown>) => void;
    17: (message: Record<string, unknown>) => void;
    18: (info: Record<string, unknown>) => void;
    27: (data: Record<string, unknown>) => void;
    // Push events are emitted by numeric code (Constants.PushCodes).
    0x80: (advert: Record<string, unknown>) => void;
    0x82: (response: Record<string, unknown>) => void;
    0x8a: (advert: Record<string, unknown>) => void;
  };

  export type MeshcoreNeighbour = {
    publicKeyPrefix: Uint8Array;
    heardSecondsAgo: number;
    /** SNR in dB (library pre-scales the raw quarter-dB byte). */
    snr: number;
  };

  export type MeshcoreNeighboursResponse = {
    totalNeighboursCount: number;
    neighbours: MeshcoreNeighbour[];
  };

  /** Repeater health counters parsed by the library from a StatusResponse push. */
  export type MeshcoreRepeaterStats = {
    batt_milli_volts: number;
    curr_tx_queue_len: number;
    noise_floor: number;
    last_rssi: number;
    n_packets_recv: number;
    n_packets_sent: number;
    total_air_time_secs: number;
    total_up_time_secs: number;
    n_sent_flood: number;
    n_sent_direct: number;
    n_recv_flood: number;
    n_recv_direct: number;
    err_events: number;
    /** Raw int16; quarter-dB like every other SNR field in the protocol. */
    last_snr: number;
    n_direct_dups: number;
    n_flood_dups: number;
  };

  export class TCPConnection extends EventEmitter {
    constructor(host: string, port: number);
    connect(): Promise<void>;
    close(): void;
    write(bytes: Uint8Array): Promise<void>;
    writeFrame(frameType: number, frameData: Uint8Array): Promise<void>;
    sendToRadioFrame(data: Uint8Array): Promise<void>;

    sendCommandAppStart(): Promise<void>;
    sendCommandDeviceQuery(appTargetVer: number): Promise<void>;
    sendCommandGetContacts(): Promise<void>;
    sendCommandGetBatteryVoltage(): Promise<void>;
    sendCommandGetChannel(channelIdx: number): Promise<void>;
    sendCommandSyncNextMessage(): Promise<void>;
    sendCommandSetAdvertLatLon(latitude: number, longitude: number): Promise<void>;
    /** Set advertised lat/lon. Arguments are int32 degrees * 1e6 (not decimal degrees). */
    setAdvertLatLong(latitude: number, longitude: number): Promise<void>;
    sendTextMessage(
      pubKey: Uint8Array,
      text: string,
      type?: number,
    ): Promise<{ expectedAckCrc?: number; estTimeout?: number }>;
    sendChannelTextMessage(channelIdx: number, text: string): Promise<void>;
    getSelfInfo(timeoutMillis?: number | null): Promise<Record<string, unknown>>;
    getContacts(): Promise<Array<Record<string, unknown>>>;
    getWaitingMessages(): Promise<Array<Record<string, unknown>> | null>;
    syncNextMessage(): Promise<Record<string, unknown> | null>;
    /** Send a self-advert limited to direct-range neighbours. */
    sendZeroHopAdvert(): Promise<void>;
    /** Send a self-advert that is flooded across the mesh. */
    sendFloodAdvert(): Promise<void>;

    /**
     * Ask a (repeater-class) node which neighbours it currently hears.
     * Rejects with the bare string "timeout" when the request expires.
     * ON AIR: implemented via SendBinaryReq to the target node.
     */
    getNeighbours(
      publicKey: Uint8Array,
      count?: number,
      offset?: number,
      orderBy?: number,
      pubKeyPrefixLength?: number,
    ): Promise<MeshcoreNeighboursResponse>;

    /**
     * Pull a remote node's status frame (repeater-class feature: stack/radio
     * health counters). Rejects with the bare string "timeout" when the
     * request expires. ON AIR: implemented via SendStatusReq to the target.
     */
    getStatus(
      contactPublicKey: Uint8Array,
      extraTimeoutMillis?: number,
    ): Promise<MeshcoreRepeaterStats>;

    // NOTE: the library emits most response events by numeric code
    // (Constants.ResponseCodes / PushCodes), not by friendly name.
    on(event: string | number, listener: (...args: any[]) => void): this;
    off(event: string | number, listener: (...args: any[]) => void): this;
    once(event: string | number, listener: (...args: any[]) => void): this;
  }

  export default TCPConnection;
}
