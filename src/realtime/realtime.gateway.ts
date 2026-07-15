import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

/**
 * Single realtime gateway used to push events to both drivers and riders.
 *
 * A client identifies itself after connecting by emitting `register` with
 * `{ role: 'driver' | 'rider', id: '<mongoId>' }`. The gateway then joins that
 * socket to a room named `driver:<id>` or `rider:<id>` so the rest of the app
 * can address a specific participant without tracking socket ids itself.
 *
 * Chosen over plain polling because it lets us demonstrate true "notify N
 * drivers simultaneously" fan-out with a single server-side emit-to-room call,
 * and lets a rider see their ride flip to ASSIGNED/TIMEOUT live. See README
 * "Design choices" for the write-up on why WebSockets were picked over SSE /
 * polling for this assignment.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  handleConnection(client: Socket) {
    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('register')
  handleRegister(client: Socket, payload: { role: 'driver' | 'rider'; id: string }) {
    if (!payload?.role || !payload?.id) return;
    const room = `${payload.role}:${payload.id}`;
    client.join(room);
    this.logger.debug(`Socket ${client.id} joined room ${room}`);
    client.emit('registered', { room });
  }

  notifyDriver(driverId: string, event: string, payload: unknown) {
    this.server.to(`driver:${driverId}`).emit(event, payload);
  }

  notifyRider(riderId: string, event: string, payload: unknown) {
    this.server.to(`rider:${riderId}`).emit(event, payload);
  }
}
