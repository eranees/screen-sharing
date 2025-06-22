import { Module } from '@nestjs/common';
import { MediasoupService } from './mediasoup.service';
import { SignalingGateway } from './signaling.gateway';

@Module({
  providers: [MediasoupService, SignalingGateway],
})
export class MediasoupModule {}
