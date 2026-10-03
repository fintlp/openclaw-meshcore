declare module "@liamcottle/meshcore.js" {
  import type { EventEmitter } from "node:events";

  export const Constants: {
    PushCodes: {
      SendConfirmed: 0x82;
      Advert: 0x80;
      NewAdvert: 0x8a;
      // other push codes may be added as needed
    };
    // other constant groups may be added as needed
  };

  export type TCPConnectionEventMap = {
    connected: () => void;
    disconnected: () => void;
    error: (error: Error) => void;
    rx: (frame: Uint8Array) => void;
    tx: (frame: Uint8Array) => void;
    SelfInfo: (info: Record<string, unknown>) => void;
    DeviceInfo: (info: Record<string, unknown>) => void;
    Contact: (contact: Record<string, unknown>) => void;
    EndOfContacts: () => void;
    ChannelInfo: (info: Record<string, unknown>) => void;
    ContactMsgRecv: (message: Record<string, unknown>) => void;
    ChannelMsgRecv: (message: Record<string, unknown>) => void;
    ChannelDataRecv: (data: Record<string, unknown>) => void;
    BatteryVoltage: (info: Record<string, unknown>) => void;
    Ok: () => void;
    Err: (error: Record<string, unknown>) => void;
    Sent: (response: Record<string, unknown>) => void;
    MsgWaiting: () => void;
    SendConfirmed: (response: Record<string, unknown>) => void;
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

    // NOTE: the library emits most response events by numeric code
    // (Constants.ResponseCodes / PushCodes), not by friendly name.
    on(event: string | number, listener: (...args: any[]) => void): this;
    off(event: string | number, listener: (...args: any[]) => void): this;
    once(event: string | number, listener: (...args: any[]) => void): this;
  }

  export default TCPConnection;
}
