import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { WS_EVENTS } from '@ai-mcq/shared-types';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Client connected to WebSocket: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected from WebSocket: ${client.id}`);
  }

  emitSessionUpdated(session: any) {
    if (this.server) {
      this.server.emit(WS_EVENTS.SESSION_UPDATED, session);
    }
  }

  emitQuestionSolved(data: any) {
    if (this.server) {
      this.server.emit(WS_EVENTS.QUESTION_SOLVED, data);
    }
  }

  emitQuestionDetected(data: any) {
    if (this.server) {
      this.server.emit(WS_EVENTS.QUESTION_DETECTED, data);
    }
  }
}

