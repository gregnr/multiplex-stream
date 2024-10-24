export type BaseHeader = {
  version: number;
  flags: number;
  streamId: number;
};

export type DataHeader = BaseHeader & {
  type: MessageType['Data'];
  length: number;
};

export type WindowUpdateHeader = BaseHeader & {
  type: MessageType['WindowUpdate'];
  windowSize: number;
};

export type PingHeader = BaseHeader & {
  type: MessageType['Ping'];
  value: number;
};

export type GoAwayHeader = BaseHeader & {
  type: MessageType['GoAway'];
  errorCode: MessageErrorCode[keyof MessageErrorCode];
};

export type Header =
  | DataHeader
  | WindowUpdateHeader
  | PingHeader
  | GoAwayHeader;

export type DataMessage = DataHeader & { data: Uint8Array };

export type WindowUpdateMessage = WindowUpdateHeader;

export type PingMessage = PingHeader;

export type GoAwayMessage = GoAwayHeader;

export type Message =
  | DataMessage
  | WindowUpdateMessage
  | PingMessage
  | GoAwayMessage;

// Preferring `const` over `enum` for type trimming purposes
export const MessageType = {
  Data: 0x0,
  WindowUpdate: 0x1,
  Ping: 0x2,
  GoAway: 0x3,
} as const;

// Preferring `const` over `enum` for type trimming purposes
export const MessageFlag = {
  SYN: 0x1,
  ACK: 0x2,
  FIN: 0x4,
  RST: 0x8,
} as const;

// Preferring `const` over `enum` for type trimming purposes
export const MessageErrorCode = {
  NormalTermination: 0x0,
  ProtocolError: 0x1,
  InternalError: 0x2,
} as const;

export type MessageType = typeof MessageType;
export type MessageFlag = typeof MessageFlag;
export type MessageErrorCode = typeof MessageErrorCode;
