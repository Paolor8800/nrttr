// «Узнай друзей» — игровые события (для анимаций/логов на клиенте).
import { GameState, GamePhase, RoundResult } from './shared-types.js';
export type GameEvent =
  | { type: 'round_started'; leaderId: string; leaderName: string; questionText: string; round: number }
  | { type: 'answer_submitted'; playerId: string }
  | { type: 'all_answers_in' }
  | { type: 'phase_changed'; phase: GamePhase }
  | { type: 'round_finished'; result: RoundResult }
  | { type: 'casino_spin'; playerId: string; resultNumber: number; scoreDelta: number }
  | { type: 'game_over'; winnerId: string | null }
  | { type: 'player_left_game'; playerId: string };

export interface GameUpdate {
  state: GameState;
  events: GameEvent[];
}

export function isGameEvent(value: unknown): value is GameEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as { type?: unknown };
  return typeof event.type === 'string';
}
