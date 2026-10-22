// «Узнай друзей» — клиентская модель игрового состояния (зеркало server/shared-types).
export type Gender = 'male' | 'female';
export type ReactionType = 'joy' | 'poop' | 'fire' | 'clown';
export const HOST_ANSWER_REACTION_ID = 'host-answer';
export type CasinoBetType = 'red' | 'black' | 'number' | 'zero';
export type CasinoColor = 'red' | 'black' | 'green';
export type AnswerReactionCounts = Record<string, Partial<Record<ReactionType, number>>>;
export type MyAnswerReactions = Record<string, ReactionType[]>;
export type FunnyVoteCounts = Record<string, number>;

export interface CasinoSpinResult {
  id: string;
  playerId: string;
  betType: CasinoBetType;
  betNumber: number | null;
  resultNumber: number;
  resultColor: CasinoColor;
  won: boolean;
  payout: number;
  scoreDelta: number;
  createdAt: number;
}

export type GamePhase = 'answering' | 'judging' | 'roundResults' | 'gameOver';

export interface Player {
  id: string;
  name: string;
  gender: Gender;
  score: number;
  hand?: string[]; // не используется; для совместимости со снапшотом сервера
}

export interface AnswerView {
  id: string;
  text: string;
}

export interface RoundResult {
  questionText: string;
  leaderId: string;
  leaderName: string;
  mostCorrectAnswerId: string | null;
  mostFunnyAnswerId: string | null;
  correctGuesses: number;
  totalGuessable: number;
  deltas: Record<string, number>;
}

export interface GameState {
  phase: GamePhase;
  round: number;
  totalRounds: number; // размер одного круга ведущих
  targetScore: number; // целевой счёт для победы
  players: Player[];
  currentLeaderIndex: number;
  questionId: string | null;
  questionText: string;
  submittedPlayerIds: string[];
  answers: AnswerView[];
  answerReactions: AnswerReactionCounts;
  myAnswerReactions: MyAnswerReactions;
  funnyVoteCounts: FunnyVoteCounts;
  funnyVotesSubmittedCount: number;
  myFunnyVoteId: string | null;
  correctAnswer: string;
  mostCorrectAnswerId: string | null;
  mostFunnyAnswerId: string | null;
  authorGuesses: Record<string, string>;
  lastResult: RoundResult | null;
  winnerId: string | null;
  casinoLastSpins: Record<string, CasinoSpinResult>;
  roomCode: string;
  hostId: string;
}

export type PlayerAction = (
  | { type: 'submit_answer'; playerId: string; payload: { text: string } }
  | { type: 'select_most_correct'; playerId: string; payload: { answerId: string } }
  | { type: 'guess_author'; playerId: string; payload: { answerId: string; guessedPlayerId: string } }
  | { type: 'vote_funniest'; playerId: string; payload: { answerId: string } }
  | { type: 'toggle_answer_reaction'; playerId: string; payload: { answerId: string; reaction: ReactionType } }
  | { type: 'casino_spin'; playerId: string; payload: { betType: CasinoBetType; betNumber?: number | null } }
  | { type: 'finish_judging'; playerId: string; payload?: Record<string, never> }
  | { type: 'next_round'; playerId: string; payload?: Record<string, never> }
) & { actionId?: string };

export interface LobbyPlayer {
  id: string;
  name: string;
  gender?: Gender;
  isHost: boolean;
  connected?: boolean;
}
