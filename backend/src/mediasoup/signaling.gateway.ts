import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MediasoupService } from './mediasoup.service';

interface ClientInfo {
  clientId: string;
  socketId: string;
  roomId?: string;
  connectedAt: Date;
  sendTransportId?: string;
  recvTransportId?: string;
}

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
})
export class SignalingGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;

  private clients = new Map<string, ClientInfo>(); // socketId -> ClientInfo
  private clientsByClientId = new Map<string, string>(); // clientId -> socketId

  constructor(private readonly mediasoupService: MediasoupService) {}

  async afterInit() {
    try {
      await this.mediasoupService.createMediaSoupWorker();
      console.log('MediaSoup worker created successfully');
    } catch (error) {
      console.error('Failed to create MediaSoup worker:', error);
    }
  }

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);

    const clientInfo: ClientInfo = {
      clientId: '',
      socketId: client.id,
      connectedAt: new Date(),
    };

    this.clients.set(client.id, clientInfo);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);

    const clientInfo = this.clients.get(client.id);
    if (clientInfo) {
      if (clientInfo.clientId) {
        this.mediasoupService.cleanupClient(clientInfo.clientId);
        this.clientsByClientId.delete(clientInfo.clientId);
      }

      this.clients.delete(client.id);

      if (clientInfo.roomId && clientInfo.clientId) {
        client.to(clientInfo.roomId).emit('clientDisconnected', {
          clientId: clientInfo.clientId,
        });
      }
    }
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(@MessageBody() body: any, @ConnectedSocket() client: Socket) {
    try {
      if (!body?.roomId || !body?.clientId) {
        return { error: 'Room ID and Client ID are required' };
      }

      const clientInfo = this.clients.get(client.id);
      if (!clientInfo) {
        return { error: 'Client info not found' };
      }

      clientInfo.clientId = body.clientId;
      clientInfo.roomId = body.roomId;
      this.clientsByClientId.set(body.clientId, client.id);

      client.join(body.roomId);

      const producers = this.mediasoupService.getProducerList(body.clientId);
      console.log(
        `Client ${body.clientId} joined room ${body.roomId}. Sending ${producers.length} existing producers`,
      );

      client.emit('existingProducers', producers);

      client.to(body.roomId).emit('clientJoined', {
        clientId: body.clientId,
      });

      return { success: true, producerCount: producers.length };
    } catch (error) {
      console.error('Error joining room:', error);
      return { error: 'Failed to join room' };
    }
  }

  @SubscribeMessage('getRtpCapabilities')
  handleRtpCapabilities(@ConnectedSocket() client: Socket) {
    console.log('getRtpCapabilities: ', client.id);
    try {
      const rtpCapabilities = this.mediasoupService.getRtpCapabilities();
      return { rtpCapabilities };
    } catch (error) {
      console.error('Error getting RTP capabilities:', error);
      return { error: 'Failed to get RTP capabilities' };
    }
  }

  @SubscribeMessage('createTransport')
  async handleCreateTransport(
    @MessageBody() body: any,
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const clientInfo = this.clients.get(client.id);
      if (!clientInfo || !clientInfo.clientId) {
        return { error: 'Client not in room' };
      }

      if (!body?.type || !['send', 'recv'].includes(body.type)) {
        return { error: 'Invalid transport type. Must be "send" or "recv"' };
      }

      const transport = await this.mediasoupService.createTransport(
        clientInfo.clientId,
        body.type,
      );

      if (body.type === 'send') {
        clientInfo.sendTransportId = transport.id;
      } else {
        clientInfo.recvTransportId = transport.id;
      }

      console.log(
        `Created ${body.type} transport ${transport.id} for client ${clientInfo.clientId}`,
      );

      return {
        transportOptions: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      };
    } catch (error) {
      console.error('Error creating transport:', error);
      return { error: 'Failed to create transport' };
    }
  }

  @SubscribeMessage('connectTransport')
  async handleConnectTransport(
    @MessageBody() body: any,
    @ConnectedSocket() client: Socket,
  ) {
    try {
      if (!body?.transportId || !body?.dtlsParameters) {
        return { error: 'Missing transport parameters' };
      }

      const clientInfo = this.clients.get(client.id);
      if (!clientInfo) {
        return { error: 'Client info not found' };
      }

      const transportInfo = this.mediasoupService.getTransportInfo(
        body.transportId,
      );
      if (!transportInfo) {
        return { error: `Transport ${body.transportId} not found` };
      }

      if (transportInfo.clientId !== clientInfo.clientId) {
        return { error: 'Transport does not belong to this client' };
      }

      await this.mediasoupService.connectTransport(
        body.transportId,
        body.dtlsParameters,
      );

      console.log(
        `Transport ${body.transportId} connected for client ${clientInfo.clientId}`,
      );
      return { connected: true };
    } catch (error) {
      console.error('Error connecting transport:', error);
      return { error: `Failed to connect transport: ${error.message}` };
    }
  }

  @SubscribeMessage('closeAllScreenShares')
  async handleCloseAllScreenShares(
    @MessageBody() body: any,
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const clientInfo = this.clients.get(client.id);
      if (!clientInfo || !clientInfo.clientId) {
        return { error: 'Client not in room' };
      }

      console.log(
        'Closing all screen shares except for client:',
        clientInfo.clientId,
      );

      const closedProducers = this.mediasoupService.closeAllScreenShares(
        clientInfo.clientId,
      );

      if (clientInfo.roomId) {
        closedProducers.forEach((producerId) => {
          this.server
            .to(clientInfo.roomId!)
            .emit('producerClosed', { producerId });
        });
      }

      return { success: true, closedCount: closedProducers.length };
    } catch (error) {
      console.error('Error closing screen shares:', error);
      return { error: 'Failed to close screen shares' };
    }
  }

  @SubscribeMessage('produce')
  async handleProduce(
    @MessageBody() body: any,
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const clientInfo = this.clients.get(client.id);
      if (!clientInfo || !clientInfo.clientId || !clientInfo.roomId) {
        return { error: 'Client not in room' };
      }

      if (!body?.transportId || !body?.kind || !body?.rtpParameters) {
        return { error: 'Missing producer parameters' };
      }

      const transportInfo = this.mediasoupService.getTransportInfo(
        body.transportId,
      );
      if (!transportInfo) {
        console.error(
          `Transport ${body.transportId} not found. Available transports for client:`,
          this.mediasoupService.getClientTransports(clientInfo.clientId),
        );
        return { error: `Transport ${body.transportId} not found` };
      }

      if (transportInfo.clientId !== clientInfo.clientId) {
        return { error: 'Transport does not belong to this client' };
      }

      if (transportInfo.type !== 'send') {
        return { error: 'Cannot produce on receive transport' };
      }

      if (!transportInfo.connected) {
        return { error: 'Transport not connected' };
      }

      console.log('Produce request:', {
        transportId: body.transportId,
        kind: body.kind,
        clientId: clientInfo.clientId,
        appData: body.appData,
        transportInfo,
      });

      const producer = await this.mediasoupService.produce(
        body.transportId,
        body.kind,
        body.rtpParameters,
        clientInfo.clientId,
        body.appData,
      );

      const broadcastData = {
        producerId: producer.id,
        kind: producer.kind,
        clientId: clientInfo.clientId,
        appData: producer.appData,
      };

      console.log(
        'Broadcasting new producer to room:',
        clientInfo.roomId,
        broadcastData,
      );

      client.to(clientInfo.roomId).emit('newProducer', broadcastData);

      return { producerId: producer.id };
    } catch (error) {
      console.error('Error producing:', error);
      return { error: `Failed to produce: ${error.message}` };
    }
  }

  @SubscribeMessage('consume')
  async handleConsume(
    @MessageBody() body: any,
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const clientInfo = this.clients.get(client.id);
      if (!clientInfo || !clientInfo.clientId) {
        return { error: 'Client not in room' };
      }

      if (!body?.transportId || !body?.producerId || !body?.rtpCapabilities) {
        return { error: 'Missing consumer parameters' };
      }

      const transportInfo = this.mediasoupService.getTransportInfo(
        body.transportId,
      );
      if (!transportInfo) {
        return { error: `Transport ${body.transportId} not found` };
      }

      if (transportInfo.clientId !== clientInfo.clientId) {
        return { error: 'Transport does not belong to this client' };
      }

      if (transportInfo.type !== 'recv') {
        return { error: 'Cannot consume on send transport' };
      }

      if (!transportInfo.connected) {
        return { error: 'Transport not connected' };
      }

      console.log('Consume request:', {
        transportId: body.transportId,
        producerId: body.producerId,
        clientId: clientInfo.clientId,
      });

      const consumer = await this.mediasoupService.consume(
        body.transportId,
        body.producerId,
        body.rtpCapabilities,
      );

      console.log('Consumer created successfully:', {
        consumerId: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        clientId: clientInfo.clientId,
      });

      return {
        consumerId: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      };
    } catch (error) {
      console.error('Error consuming:', error);
      return { error: `Failed to consume: ${error.message}` };
    }
  }

  @SubscribeMessage('getStats')
  handleGetStats(@ConnectedSocket() client: Socket) {
    try {
      const clientInfo = this.clients.get(client.id);
      const mediasoupStats = this.mediasoupService.getStats();

      return {
        mediasoup: mediasoupStats,
        gateway: {
          connectedClients: this.clients.size,
          clientsInRooms: Array.from(this.clientsByClientId.keys()).length,
        },
        client: clientInfo
          ? {
              clientId: clientInfo.clientId,
              roomId: clientInfo.roomId,
              sendTransportId: clientInfo.sendTransportId,
              recvTransportId: clientInfo.recvTransportId,
              transports: clientInfo.clientId
                ? this.mediasoupService.getClientTransports(clientInfo.clientId)
                : [],
            }
          : null,
      };
    } catch (error) {
      console.error('Error getting stats:', error);
      return { error: 'Failed to get stats' };
    }
  }
}
