import { Injectable } from '@nestjs/common';
import { createWorker, types } from 'mediasoup';
import type {
  Worker,
  Router,
  WebRtcTransport,
  RtpCapabilities,
  MediaKind,
} from 'mediasoup/node/lib/types';

interface TransportInfo {
  transport: WebRtcTransport;
  clientId: string;
  type: 'send' | 'recv';
  connected: boolean;
  createdAt: Date;
}

@Injectable()
export class MediasoupService {
  private worker: Worker;
  private router: Router;
  private transports = new Map<string, TransportInfo>();
  private producers = new Map<string, types.Producer>();
  private consumers = new Map<string, types.Consumer>();
  private clientTransports = new Map<string, Set<string>>(); // clientId -> Set of transportIds

  async createMediaSoupWorker() {
    try {
      this.worker = await createWorker({
        rtcMinPort: 40000,
        rtcMaxPort: 49999,
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      });

      console.log('Worker created, PID:', this.worker.pid);

      this.worker.on('died', () => {
        console.error('MediaSoup worker died, exiting...');
        process.exit(1);
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

      console.log('Router created');
    } catch (error) {
      console.error('Error creating worker or router:', error);
      throw error;
    }
  }

  getRtpCapabilities(): RtpCapabilities {
    if (!this.router) {
      throw new Error('Router not initialized');
    }
    return this.router.rtpCapabilities;
  }

  async createTransport(
    clientId: string,
    type: 'send' | 'recv',
  ): Promise<WebRtcTransport> {
    if (!this.router) {
      throw new Error('Router not initialized');
    }

    try {
      const transport = await this.router.createWebRtcTransport({
        listenIps: [
          {
            ip: '0.0.0.0',
            announcedIp: null, // actual IP
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000,
        maxSctpMessageSize: 262144,
      });

      const transportInfo: TransportInfo = {
        transport,
        clientId,
        type,
        connected: false,
        createdAt: new Date(),
      };

      this.transports.set(transport.id, transportInfo);

      if (!this.clientTransports.has(clientId)) {
        this.clientTransports.set(clientId, new Set());
      }
      this.clientTransports.get(clientId)!.add(transport.id);

      transport.on('dtlsstatechange', (dtlsState) => {
        console.log(
          `Transport ${transport.id} DTLS state changed to: ${dtlsState}`,
        );
        if (dtlsState === 'closed') {
          console.log(`Transport ${transport.id} closed via DTLS state change`);
          this.cleanupTransport(transport.id);
        } else if (dtlsState === 'connected') {
          const info = this.transports.get(transport.id);
          if (info) {
            info.connected = true;
            console.log(
              `Transport ${transport.id} connected for client ${clientId}`,
            );
          }
        }
      });

      transport.on('@close', () => {
        console.log(`Transport ${transport.id} closed`);
        this.cleanupTransport(transport.id);
      });

      setTimeout(
        () => {
          const info = this.transports.get(transport.id);
          if (info && !info.connected) {
            console.log(
              `Cleaning up unconnected transport ${transport.id} after timeout`,
            );
            this.cleanupTransport(transport.id);
          }
        },
        30 * 60 * 1000,
      );

      console.log(
        `Transport created: ${transport.id} for client ${clientId} (${type})`,
      );
      return transport;
    } catch (error) {
      console.error('Error creating transport:', error);
      throw error;
    }
  }

  private cleanupTransport(transportId: string) {
    const transportInfo = this.transports.get(transportId);
    if (transportInfo) {
      const clientTransportSet = this.clientTransports.get(
        transportInfo.clientId,
      );
      if (clientTransportSet) {
        clientTransportSet.delete(transportId);
        if (clientTransportSet.size === 0) {
          this.clientTransports.delete(transportInfo.clientId);
        }
      }

      if (!transportInfo.transport.closed) {
        transportInfo.transport.close();
      }

      this.transports.delete(transportId);
    }
  }

  async connectTransport(transportId: string, dtlsParameters: any) {
    const transportInfo = this.transports.get(transportId);
    if (!transportInfo) {
      throw new Error(`Transport not found: ${transportId}`);
    }

    if (transportInfo.transport.closed) {
      throw new Error(`Transport ${transportId} is closed`);
    }

    try {
      await transportInfo.transport.connect({ dtlsParameters });
      transportInfo.connected = true;
      console.log(`Transport ${transportId} connected successfully`);
    } catch (error) {
      console.error(`Error connecting transport ${transportId}:`, error);
      throw error;
    }
  }

  async produce(
    transportId: string,
    kind: string,
    rtpParameters: any,
    clientId: string,
    appData?: any,
  ) {
    const transportInfo = this.transports.get(transportId);
    if (!transportInfo) {
      console.error(
        `Transport not found: ${transportId}. Available transports:`,
        Array.from(this.transports.keys()),
      );
      throw new Error(`Transport not found: ${transportId}`);
    }

    if (transportInfo.transport.closed) {
      console.error(`Transport ${transportId} is closed`);
      throw new Error(`Transport ${transportId} is closed`);
    }

    if (!transportInfo.connected) {
      console.error(`Transport ${transportId} is not connected`);
      throw new Error(`Transport ${transportId} is not connected`);
    }

    if (transportInfo.type !== 'send') {
      throw new Error(`Cannot produce on receive transport ${transportId}`);
    }

    try {
      const producer = await transportInfo.transport.produce({
        kind: kind as MediaKind,
        rtpParameters,
        appData: { clientId, ...appData },
      });

      this.producers.set(producer.id, producer);

      producer.on('transportclose', () => {
        console.log(`Producer ${producer.id} transport closed`);
        this.producers.delete(producer.id);
      });

      producer.on('@close', () => {
        console.log(`Producer ${producer.id} closed`);
        this.producers.delete(producer.id);
      });

      console.log(
        `Producer created: ${producer.id}, kind: ${kind}, clientId: ${clientId}, appData:`,
        producer.appData,
      );
      return producer;
    } catch (error) {
      console.error(
        `Error creating producer on transport ${transportId}:`,
        error,
      );
      throw error;
    }
  }

  async consume(
    transportId: string,
    producerId: string,
    rtpCapabilities: RtpCapabilities,
  ) {
    const transportInfo = this.transports.get(transportId);
    const producer = this.producers.get(producerId);

    if (!transportInfo) {
      throw new Error(`Transport not found: ${transportId}`);
    }

    if (transportInfo.transport.closed) {
      throw new Error(`Transport ${transportId} is closed`);
    }

    if (!transportInfo.connected) {
      throw new Error(`Transport ${transportId} is not connected`);
    }

    if (transportInfo.type !== 'recv') {
      throw new Error(`Cannot consume on send transport ${transportId}`);
    }

    if (!producer) {
      throw new Error(`Producer not found: ${producerId}`);
    }

    if (producer.closed) {
      throw new Error(`Producer ${producerId} is closed`);
    }

    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error('Cannot consume - RTP capabilities not compatible');
    }

    try {
      const consumer = await transportInfo.transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });

      this.consumers.set(consumer.id, consumer);

      consumer.on('transportclose', () => {
        console.log(`Consumer ${consumer.id} transport closed`);
        this.consumers.delete(consumer.id);
      });

      consumer.on('producerclose', () => {
        console.log(`Consumer ${consumer.id} producer closed`);
        this.consumers.delete(consumer.id);
      });

      consumer.on('@close', () => {
        console.log(`Consumer ${consumer.id} closed`);
        this.consumers.delete(consumer.id);
      });

      console.log(
        `Consumer created: ${consumer.id} for producer: ${producerId}`,
      );
      return consumer;
    } catch (error) {
      console.error(
        `Error creating consumer on transport ${transportId}:`,
        error,
      );
      throw error;
    }
  }

  closeAllScreenShares(excludeClientId?: string): string[] {
    const closedProducerIds: string[] = [];

    this.producers.forEach((producer, producerId) => {
      if (
        producer.appData?.source === 'screen' &&
        producer.kind === 'video' &&
        producer.appData?.clientId !== excludeClientId
      ) {
        console.log(
          `Closing screen share producer: ${producerId} from client: ${producer.appData?.clientId}`,
        );
        producer.close();
        this.producers.delete(producerId);
        closedProducerIds.push(producerId);
      }
    });

    console.log(`Closed ${closedProducerIds.length} screen share producers`);
    return closedProducerIds;
  }

  getProducerList(clientId: string) {
    return Array.from(this.producers.values())
      .filter((p) => p.appData.clientId !== clientId && !p.closed)
      .map((p) => ({
        producerId: p.id,
        kind: p.kind,
        clientId: p.appData.clientId,
        appData: p.appData,
      }));
  }

  getTransportInfo(transportId: string) {
    const info = this.transports.get(transportId);
    if (!info) return null;

    return {
      id: transportId,
      clientId: info.clientId,
      type: info.type,
      connected: info.connected,
      closed: info.transport.closed,
      createdAt: info.createdAt,
    };
  }

  getClientTransports(clientId: string) {
    const transportIds = this.clientTransports.get(clientId) || new Set();
    return Array.from(transportIds)
      .map((id) => this.getTransportInfo(id))
      .filter(Boolean);
  }

  cleanupClient(clientId: string) {
    console.log(`Cleaning up resources for client: ${clientId}`);

    const transportIds = this.clientTransports.get(clientId) || new Set();

    transportIds.forEach((transportId) => {
      this.cleanupTransport(transportId);
    });

    this.producers.forEach((producer, producerId) => {
      if (producer.appData.clientId === clientId) {
        console.log(`Closing producer ${producerId} for client ${clientId}`);
        producer.close();
        this.producers.delete(producerId);
      }
    });

    this.consumers.forEach((consumer, consumerId) => {
      if (consumer.appData?.clientId === clientId) {
        console.log(`Closing consumer ${consumerId} for client ${clientId}`);
        consumer.close();
        this.consumers.delete(consumerId);
      }
    });

    console.log(`Cleanup completed for client: ${clientId}`);
  }

  async cleanup() {
    console.log('Cleaning up all MediaSoup resources');

    this.consumers.forEach((consumer) => {
      if (!consumer.closed) {
        consumer.close();
      }
    });
    this.consumers.clear();

    this.producers.forEach((producer) => {
      if (!producer.closed) {
        producer.close();
      }
    });
    this.producers.clear();

    this.transports.forEach((transportInfo) => {
      if (!transportInfo.transport.closed) {
        transportInfo.transport.close();
      }
    });
    this.transports.clear();
    this.clientTransports.clear();

    if (this.router && !this.router.closed) {
      this.router.close();
    }

    if (this.worker && !this.worker.closed) {
      this.worker.close();
    }
  }

  getStats() {
    return {
      transports: this.transports.size,
      producers: this.producers.size,
      consumers: this.consumers.size,
      clients: this.clientTransports.size,
      workerPid: this.worker?.pid,
      routerClosed: this.router?.closed,
    };
  }
}
