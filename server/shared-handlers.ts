// «Узнай друзей» — чистые вспомогательные функции игровой логики.
import { AnswerView, GameState, Player, RoundResult } from './shared-types.js';
/** Перемешивание Фишера–Йетса (не мутирует исходный массив). */
export function shuffle<T>(items: T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Строит анонимные перемешанные ответы игроков и карту авторства.
 * submissions — это пары [playerId, text] от НЕведущих игроков.
 */
export function buildAnonymizedAnswers(
  submissions: Array<[string, string]>,
): { answers: AnswerView[]; authorByAnswerId: Record<string, string> } {
  const shuffled = shuffle(submissions);
  const answers: AnswerView[] = [];
  const authorByAnswerId: Record<string, string> = {};
  shuffled.forEach(([playerId, text], index) => {
    const id = `a${index + 1}`;
    answers.push({ id, text });
    authorByAnswerId[id] = playerId;
  });
  return { answers, authorByAnswerId };
}

/**
 * Подсчёт очков по завершении раунда судейства.
 * Возвращает дельты по playerId и сводку результата.
 */
export function computeRoundScores(params: {
  state: GameState;
  authorByAnswerId: Record<string, string>;
}): { deltas: Record<string, number>; result: RoundResult } {
  const { state, authorByAnswerId } = params;
  const leader = state.players[state.currentLeaderIndex];
  const deltas: Record<string, number> = {};
  state.players.forEach((p) => {
    deltas[p.id] = 0;
  });

  // +2 автору «самого правильного» ответа
  if (state.mostCorrectAnswerId && authorByAnswerId[state.mostCorrectAnswerId]) {
    deltas[authorByAnswerId[state.mostCorrectAnswerId]] += 2;
  }
  // +2 автору «самого смешного» ответа
  if (state.mostFunnyAnswerId && authorByAnswerId[state.mostFunnyAnswerId]) {
    deltas[authorByAnswerId[state.mostFunnyAnswerId]] += 2;
  }
  // +1 ведущему за каждого угаданного автора
  let correctGuesses = 0;
  for (const [answerId, guessedPlayerId] of Object.entries(state.authorGuesses)) {
    if (authorByAnswerId[answerId] && authorByAnswerId[answerId] === guessedPlayerId) {
      correctGuesses += 1;
    }
  }
  if (leader) deltas[leader.id] += correctGuesses;

  const result: RoundResult = {
    questionText: state.questionText,
    leaderId: leader?.id ?? '',
    leaderName: leader?.name ?? '',
    mostCorrectAnswerId: state.mostCorrectAnswerId,
    mostFunnyAnswerId: state.mostFunnyAnswerId,
    correctGuesses,
    totalGuessable: state.answers.length,
    deltas,
  };
  return { deltas, result };
}

/** Применяет дельты очков к игрокам (возвращает новый массив). */
export function applyDeltas(players: Player[], deltas: Record<string, number>): Player[] {
  return players.map((p) => ({ ...p, score: p.score + (deltas[p.id] ?? 0) }));
}

/** Определяет победителя (наибольший счёт). null при ничьей вверху таблицы. */
export function pickWinnerId(players: Player[]): string | null {
  if (players.length === 0) return null;
  const sorted = [...players].sort((a, b) => b.score - a.score);
  if (sorted.length > 1 && sorted[0].score === sorted[1].score) return null;
  return sorted[0].id;
}
