import { Module } from '@nestjs/common';
import { SocketService } from './socket.service';
import { SocketGateway } from './socket.gateway';

@Module({
  imports: [],
  providers: [SocketGateway, SocketService],
})
export class SocketModule {}
