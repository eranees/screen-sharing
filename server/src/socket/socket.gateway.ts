import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import {
  Worker,
  WebRtcTransport,
  Router,
  Producer,
} from 'mediasoup/node/lib/types';
import { createWorker } from 'mediasoup';
import { Server, Socket } from 'socket.io';
import { SocketService } from './socket.service';
import {
  JoinRoomRequest,
  CreateTransportRequest,
  ConnectTransportRequest,
  ProduceRequest,
  ConsumeRequest,
  StartScreenShareRequest,
  StopScreenShareRequest,
  JoinRoomResponse,
  RtpCapabilitiesResponse,
  CreateTransportResponse,
  ProduceResponse,
  ConsumeResponse,
  ScreenShareResponse,
  BaseResponse,
} from './socket.types';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class SocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(SocketGateway.name);

  private worker: Worker;
  private router: Router;

  private sendTransports = new Map<string, WebRtcTransport>(); // key: `${client.id}-send`
  private recvTransports = new Map<string, WebRtcTransport>(); // key: `${client.id}-recv`

  private producers = new Map<
    string,
    { socketId: string; producer: Producer; mediaType: 'camera' | 'screen' }[]
  >();
  private peers = new Map<string, any>();
  rooms = new Map<string, Set<string>>();

  // Track screen share producers separately
  private screenShareProducers = new Map<string, string>(); // socketId -> producerId

  constructor(private readonly socketService: SocketService) {}

  async afterInit(server: Server) {
    console.log(server);
    try {
      this.worker = await createWorker({
        logLevel: 'debug',
        logTags: [
          'info',
          'ice',
          'dtls',
          'rtp',
          'srtp',
          'rtcp',
          'rtx',
          'bwe',
          'score',
          'simulcast',
          'svc',
        ],
      });

      this.router = await this.worker.createRouter({
        mediaCodecs: [
          {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
          },
          {
            kind: 'video',
            mimeType: 'video/VP8',
            clockRate: 90000,
            parameters: {
              'x-google-start-bitrate': 1000,
            },
          },
          {
            kind: 'video',
            mimeType: 'video/VP9',
            clockRate: 90000,
            parameters: {
              'profile-id': 2,
              'x-google-start-bitrate': 1000,
            },
          },
          {
            kind: 'video',
            mimeType: 'video/h264',
            clockRate: 90000,
            parameters: {
              'packetization-mode': 1,
              'profile-level-id': '4d0032',
              'level-asymmetry-allowed': 1,
              'x-google-start-bitrate': 1000,
            },
          },
        ],
      });

      this.logger.log('MediaSoup worker and router initialized');
    } catch (error) {
      this.logger.error('Failed to initialize MediaSoup:', error);
    }
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.peers.set(client.id, {});
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.peers.delete(client.id);

    // Check if client was sharing screen
    const screenShareProducerId = this.screenShareProducers.get(client.id);
    if (screenShareProducerId) {
      this.screenShareProducers.delete(client.id);
      // Notify room about screen share stop
      const roomId = this.findRoomByClient(client.id);
      if (roomId) {
        client.to(roomId).emit('screen-share-stopped', {
          producerId: screenShareProducerId,
          socketId: client.id,
        });
      }
    }

    // Cleanup transports and producers
    const sendTransport = this.sendTransports.get(`${client.id}-send`);
    if (sendTransport) {
      sendTransport.close();
      this.sendTransports.delete(`${client.id}-send`);
    }

    const recvTransport = this.recvTransports.get(`${client.id}-recv`);
    if (recvTransport) {
      recvTransport.close();
      this.recvTransports.delete(`${client.id}-recv`);
    }

    // Remove from rooms
    for (const [roomId, clients] of this.rooms.entries()) {
      if (clients.has(client.id)) {
        clients.delete(client.id);
        if (clients.size === 0) {
          this.rooms.delete(roomId);
        }
      }
    }

    // Remove producers
    for (const [roomId, producers] of this.producers.entries()) {
      const filtered = producers.filter((p) => p.socketId !== client.id);
      if (filtered.length === 0) {
        this.producers.delete(roomId);
      } else {
        this.producers.set(roomId, filtered);
      }
    }
  }

  @SubscribeMessage('join-room')
  handleJoinRoom(
    @MessageBody() data: JoinRoomRequest,
    @ConnectedSocket() client: Socket,
  ): JoinRoomResponse {
    try {
      const { roomId } = data;

      if (!roomId) {
        throw new Error('Room ID is required');
      }

      if (!this.rooms.has(roomId)) {
        this.rooms.set(roomId, new Set());
      }

      this.rooms.get(roomId)!.add(client.id);
      client.join(roomId);
      client.data.roomId = roomId;

      const existingProducers = this.producers.get(roomId) || [];

      this.logger.log(`Client ${client.id} joined room ${roomId}`);

      return {
        success: true,
        producers: existingProducers.map((p) => ({
          producerId: p.producer.id,
          socketId: p.socketId,
          mediaType: p.mediaType,
          kind: p.producer.kind,
        })),
      };
    } catch (error) {
      this.logger.error(`[join-room] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('get-rtp-capabilities')
  handleRtpCapabilities(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ): RtpCapabilitiesResponse {
    try {
      console.log(data, client);
      return {
        success: true,
        rtpCapabilities: this.router.rtpCapabilities,
      };
    } catch (error) {
      this.logger.error(`[get-rtp-capabilities] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('create-transport')
  async handleCreateTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: CreateTransportRequest,
  ): Promise<CreateTransportResponse> {
    try {
      const { direction } = data;

      if (!direction || !['send', 'recv'].includes(direction)) {
        throw new Error('Invalid direction specified');
      }

      const transport = await this.router.createWebRtcTransport({
        listenIps: [
          {
            ip: '0.0.0.0',
            announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1',
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        enableSctp: false,
        numSctpStreams: { OS: 1024, MIS: 1024 },
        maxSctpMessageSize: 262144,
        sctpSendBufferSize: 262144,
        initialAvailableOutgoingBitrate: 1000000,
      });

      const transportKey = `${client.id}-${direction}`;

      if (direction === 'send') {
        this.sendTransports.set(transportKey, transport);
      } else {
        this.recvTransports.set(transportKey, transport);
      }

      transport.on('dtlsstatechange', (dtlsState) => {
        this.logger.log(
          `Transport ${transport.id} DTLS state changed to ${dtlsState}`,
        );
      });

      transport.on('icestatechange', (iceState) => {
        this.logger.log(
          `Transport ${transport.id} ICE state changed to ${iceState}`,
        );
      });

      this.logger.log(`Created ${direction} transport for client ${client.id}`);

      return {
        success: true,
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      };
    } catch (error) {
      this.logger.error(`[create-transport] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('connect-transport')
  async handleConnectTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ConnectTransportRequest,
  ): Promise<BaseResponse> {
    try {
      const { transportId, dtlsParameters } = data;

      if (!transportId || !dtlsParameters) {
        throw new Error('Transport ID and DTLS parameters are required');
      }

      const sendTransport = this.sendTransports.get(`${client.id}-send`);
      const recvTransport = this.recvTransports.get(`${client.id}-recv`);

      let transport = null;

      if (sendTransport && sendTransport.id === transportId) {
        transport = sendTransport;
      } else if (recvTransport && recvTransport.id === transportId) {
        transport = recvTransport;
      }

      if (!transport) {
        throw new Error('Transport not found');
      }

      await transport.connect({ dtlsParameters });

      this.logger.log(
        `Connected transport ${transportId} for client ${client.id}`,
      );

      return { success: true };
    } catch (error) {
      this.logger.error(`[connect-transport] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('produce')
  async handleProduce(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: ProduceRequest,
  ): Promise<ProduceResponse> {
    try {
      const { transportId, kind, rtpParameters, appData } = data;

      if (!transportId || !kind || !rtpParameters) {
        throw new Error('Transport ID, kind, and RTP parameters are required');
      }

      const transport = this.sendTransports.get(`${client.id}-send`);
      if (!transport) {
        throw new Error('Send transport not found');
      }

      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: appData || {},
      });

      const roomId = client.data.roomId;
      if (!roomId) {
        throw new Error('Client not in a room');
      }

      const mediaType = appData?.mediaType || 'camera';

      if (!this.producers.has(roomId)) {
        this.producers.set(roomId, []);
      }

      this.producers.get(roomId)!.push({
        socketId: client.id,
        producer,
        mediaType,
      });

      // If this is a screen share, track it separately
      if (mediaType === 'screen') {
        this.screenShareProducers.set(client.id, producer.id);
        client.to(roomId).emit('screen-share-started', {
          producerId: producer.id,
          socketId: client.id,
        });
      } else {
        client.to(roomId).emit('new-producer', {
          producerId: producer.id,
          socketId: client.id,
          mediaType,
          kind,
        });
      }

      this.logger.log(
        `Producer ${producer.id} (${mediaType}) created for client ${client.id} in room ${roomId}`,
      );

      return { success: true, id: producer.id };
    } catch (error) {
      this.logger.error(`[produce] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('start-screen-share')
  async handleStartScreenShare(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: StartScreenShareRequest,
  ): Promise<ScreenShareResponse> {
    try {
      const { transportId, rtpParameters } = data;

      if (!transportId || !rtpParameters) {
        throw new Error('Transport ID and RTP parameters are required');
      }

      // Check if client is already sharing screen
      if (this.screenShareProducers.has(client.id)) {
        throw new Error('Client is already sharing screen');
      }

      const transport = this.sendTransports.get(`${client.id}-send`);
      if (!transport) {
        throw new Error('Send transport not found');
      }

      const producer = await transport.produce({
        kind: 'video',
        rtpParameters,
        appData: { mediaType: 'screen' },
      });

      const roomId = client.data.roomId;
      if (!roomId) {
        throw new Error('Client not in a room');
      }

      if (!this.producers.has(roomId)) {
        this.producers.set(roomId, []);
      }

      this.producers.get(roomId)!.push({
        socketId: client.id,
        producer,
        mediaType: 'screen',
      });

      this.screenShareProducers.set(client.id, producer.id);

      client.to(roomId).emit('screen-share-started', {
        producerId: producer.id,
        socketId: client.id,
      });

      this.logger.log(
        `Screen share producer ${producer.id} created for client ${client.id} in room ${roomId}`,
      );

      return { success: true, producerId: producer.id };
    } catch (error) {
      this.logger.error(`[start-screen-share] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('stop-screen-share')
  async handleStopScreenShare(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: StopScreenShareRequest,
  ): Promise<BaseResponse> {
    try {
      this.logger.log(data);
      const screenShareProducerId = this.screenShareProducers.get(client.id);

      if (!screenShareProducerId) {
        throw new Error('No active screen share found');
      }

      const roomId = client.data.roomId;
      if (!roomId) {
        throw new Error('Client not in a room');
      }

      // Find and close the producer
      const roomProducers = this.producers.get(roomId) || [];
      const producerIndex = roomProducers.findIndex(
        (p) =>
          p.producer.id === screenShareProducerId && p.socketId === client.id,
      );

      if (producerIndex !== -1) {
        const { producer } = roomProducers[producerIndex];
        producer.close();
        roomProducers.splice(producerIndex, 1);

        if (roomProducers.length === 0) {
          this.producers.delete(roomId);
        } else {
          this.producers.set(roomId, roomProducers);
        }
      }

      this.screenShareProducers.delete(client.id);

      client.to(roomId).emit('screen-share-stopped', {
        producerId: screenShareProducerId,
        socketId: client.id,
      });

      this.logger.log(
        `Screen share stopped for client ${client.id} in room ${roomId}`,
      );

      return { success: true };
    } catch (error) {
      this.logger.error(`[stop-screen-share] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  @SubscribeMessage('consume')
  async handleConsume(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ConsumeRequest,
  ): Promise<ConsumeResponse> {
    try {
      const { producerId, rtpCapabilities } = data;

      if (!producerId || !rtpCapabilities) {
        throw new Error('Producer ID and RTP capabilities are required');
      }

      const roomId = client.data.roomId;
      if (!roomId) {
        throw new Error('Client not in a room');
      }

      const producerData = this.findProducerData(roomId, producerId);
      if (!producerData) {
        throw new Error('Producer not found');
      }

      if (!this.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error('Cannot consume - incompatible RTP capabilities');
      }

      const transport = this.recvTransports.get(`${client.id}-recv`);
      if (!transport) {
        throw new Error('Receive transport not found');
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });

      this.logger.log(
        `Consumer ${consumer.id} created for client ${client.id}`,
      );

      return {
        success: true,
        producerId: consumer.producerId,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        mediaType: producerData.mediaType,
      };
    } catch (error) {
      this.logger.error(`[consume] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  private findRoomByClient(clientId: string): string | undefined {
    for (const [roomId, clients] of this.rooms.entries()) {
      if (clients.has(clientId)) {
        return roomId;
      }
    }
    return undefined;
  }

  private findProducerData(
    roomId: string,
    producerId: string,
  ): { producer: Producer; mediaType: 'camera' | 'screen' } | undefined {
    const roomProducers = this.producers.get(roomId) || [];
    const producerData = roomProducers.find(
      (p) => p.producer.id === producerId,
    );
    if (producerData) {
      return {
        producer: producerData.producer,
        mediaType: producerData.mediaType,
      };
    }
    return undefined;
  }
}
