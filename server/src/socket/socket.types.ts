import {
  MediaKind,
  RtpParameters,
  DtlsParameters,
  RtpCapabilities,
} from 'mediasoup/node/lib/types';

// Request types
export interface JoinRoomRequest {
  roomId: string;
}

export interface CreateTransportRequest {
  direction: 'send' | 'recv';
}

export interface ConnectTransportRequest {
  transportId: string;
  dtlsParameters: DtlsParameters;
}

export interface ProduceRequest {
  transportId: string;
  kind: MediaKind;
  rtpParameters: RtpParameters;
  appData?: {
    mediaType?: 'camera' | 'screen';
  };
}

export interface ConsumeRequest {
  producerId: string;
  rtpCapabilities: RtpCapabilities;
}

export interface StartScreenShareRequest {
  transportId: string;
  rtpParameters: RtpParameters;
}

export interface StopScreenShareRequest {
  producerId: string;
}

// Response types
export interface BaseResponse {
  success: boolean;
  error?: string;
}

export interface JoinRoomResponse extends BaseResponse {
  producers?: Array<{
    producerId: string;
    socketId: string;
    mediaType?: 'camera' | 'screen';
    kind: MediaKind;
  }>;
}

export interface RtpCapabilitiesResponse extends BaseResponse {
  rtpCapabilities?: RtpCapabilities;
}

export interface CreateTransportResponse extends BaseResponse {
  id?: string;
  iceParameters?: any;
  iceCandidates?: any;
  dtlsParameters?: DtlsParameters;
}

export interface ProduceResponse extends BaseResponse {
  id?: string;
}

export interface ConsumeResponse extends BaseResponse {
  producerId?: string;
  id?: string;
  kind?: MediaKind;
  rtpParameters?: RtpParameters;
  mediaType?: 'camera' | 'screen';
}

export interface ScreenShareResponse extends BaseResponse {
  producerId?: string;
}

// Events
export interface NewProducerEvent {
  producerId: string;
  socketId: string;
  mediaType?: 'camera' | 'screen';
  kind: MediaKind;
}

export interface ScreenShareStartedEvent {
  producerId: string;
  socketId: string;
}

export interface ScreenShareStoppedEvent {
  producerId: string;
  socketId: string;
}
