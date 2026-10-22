import { GameState, PlayerAction } from './shared-types.js';
import { GameEvent } from './shared-events.js';

export type LobbyPlayer = { id: string; name: string; gender?: import('./shared-types.js').Gender; isHost: boolean; connected?: boolean };

export type ServerEvent =
  | { type: 'connected'; playerId: string; roomCode: string; sessionId: string; isHost: boolean }
  | { type: 'lobby_state'; roomCode: string; players: LobbyPlayer[]; ownerId: string | null; gameInProgress: boolean }
  | { type: 'game_state'; state: GameState }
  | { type: 'game_event'; event: GameEvent }
  | { type: 'action_rejected'; reason: string; actionType?: string }
  | { type: 'action_ack'; actionId: string }
  | { type: 'player_kicked'; roomCode: string }
  | { type: 'room_closed'; roomCode: string; reason: string }
  | { type: 'pong' }
  | { type: 'error'; message: string; code?: RoomErrorCode; fatal?: boolean };

/** fatal-ошибки означают, что переподключаться к этой комнате бессмысленно. */
export type RoomErrorCode = 'invalid_room' | 'room_not_found' | 'room_stale' | 'room_full' | 'kicked' | 'bad_request';

export type ClientMessage =
  | { type: 'identify'; roomCode: string; playerName: string; gender?: import('./shared-types.js').Gender; playerId?: string; sessionId?: string; wantsHost?: boolean; is16Plus?: boolean }
  | { type: 'start_game'; is16Plus?: boolean }
  | { type: 'player_action'; action: Omit<PlayerAction, 'playerId'> }
  | { type: 'leave_room'; intentional?: boolean }
  | { type: 'kick_player'; playerId: string }
  | { type: 'request_sync' }
  | { type: 'ping' };
