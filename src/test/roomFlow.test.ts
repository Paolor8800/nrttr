import { describe, expect, it, vi } from 'vitest';
import { CASINO_SPIN_COOLDOWN_MS, Room } from '../../server/room';
import { HOST_ANSWER_REACTION_ID } from '../../server/shared-types';
import { questionsForGender } from '@/data/questions';

type RoomQuestionHistoryProbe = { usedQuestionIds: string[] };

describe('room flow', () => {
  it('starts the next game with the same players and fresh questions when possible', () => {
    const room = new Room('NEXT01');
    room.addOrUpdatePlayer('p1', 'Host', true, 'female');
    room.addOrUpdatePlayer('p2', 'Player 2', false, 'male');
    room.addOrUpdatePlayer('p3', 'Player 3', false, 'female');

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      room.startGame();
      const firstQuestionId = room.gameState!.questionId;
      room.gameState!.players = room.gameState!.players.map((player) => ({ ...player, score: player.id === 'p1' ? 20 : 4 }));
      room.gameState!.phase = 'gameOver';
      room.gameState!.winnerId = 'p1';

      room.startGame();

      expect(room.gameState!.players.map((player) => player.id)).toEqual(['p1', 'p2', 'p3']);
      expect(room.gameState!.players.map((player) => player.score)).toEqual([0, 0, 0]);
      expect(room.gameState!.questionId).not.toBe(firstQuestionId);
      expect(room.gameState!.phase).toBe('answering');
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('resets the question pool when a new game does not have enough fresh questions', () => {
    const room = new Room('RESET1');
    room.addOrUpdatePlayer('p1', 'Host', true, 'female');
    room.addOrUpdatePlayer('p2', 'Player 2', false, 'female');
    room.addOrUpdatePlayer('p3', 'Player 3', false, 'female');
    const femaleQuestionIds = questionsForGender('female').map((question) => question.id);
    const questionHistory = room as unknown as RoomQuestionHistoryProbe;
    questionHistory.usedQuestionIds = femaleQuestionIds.slice(0, -2);

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      room.startGame();

      expect(room.gameState!.questionId).toBe(femaleQuestionIds[0]);
      expect(questionHistory.usedQuestionIds).toEqual([femaleQuestionIds[0]]);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('applies casino roulette payouts without ending the game before next_round', () => {
    const room = new Room('CASINO');
    room.addOrUpdatePlayer('p1', 'Host', true, 'female');
    room.addOrUpdatePlayer('p2', 'Player 2', false, 'male');
    room.addOrUpdatePlayer('p3', 'Player 3', false, 'female');
    room.startGame();

    const player = room.gameState!.players.find((p) => p.id === 'p2')!;
    player.score = 29;
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      room.processAction('p2', {
        type: 'casino_spin',
        playerId: 'p2',
        payload: { betType: 'zero' },
      });
    } finally {
      randomSpy.mockRestore();
    }

    const spin = room.gameState!.casinoLastSpins.p2;
    expect(spin.resultNumber).toBe(0);
    expect(spin.won).toBe(true);
    expect(spin.scoreDelta).toBe(6);
    expect(room.gameState!.players.find((p) => p.id === 'p2')!.score).toBe(35);
    expect(room.gameState!.phase).toBe('answering');

    room.gameState!.phase = 'roundResults';
    room.processAction('p1', { type: 'next_round', playerId: 'p1', payload: {} });

    expect(room.gameState!.phase).toBe('gameOver');
    expect(room.gameState!.winnerId).toBe('p2');
  });

  it('forces five casino losses when a player starts a spin at 32–34 points', () => {
    const room = new Room('CASIN3');
    room.addOrUpdatePlayer('p1', 'Host', true, 'female');
    room.addOrUpdatePlayer('p2', 'Player 2', false, 'male');
    room.addOrUpdatePlayer('p3', 'Player 3', false, 'female');
    room.startGame();

    room.gameState!.players.find((p) => p.id === 'p2')!.score = 34;
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      for (let index = 0; index < 5; index += 1) {
        room.processAction('p2', {
          type: 'casino_spin',
          playerId: 'p2',
          payload: { betType: 'zero' },
        });
        vi.advanceTimersByTime(CASINO_SPIN_COOLDOWN_MS);

        const spin = room.gameState!.casinoLastSpins.p2;
        expect(spin.resultNumber).not.toBe(0);
        expect(spin.won).toBe(false);
        expect(spin.scoreDelta).toBe(-1);
      }

      expect(room.gameState!.players.find((p) => p.id === 'p2')!.score).toBe(29);

      room.processAction('p2', {
        type: 'casino_spin',
        playerId: 'p2',
        payload: { betType: 'zero' },
      });

      const randomSpin = room.gameState!.casinoLastSpins.p2;
      expect(randomSpin.resultNumber).toBe(0);
      expect(randomSpin.won).toBe(true);
      expect(randomSpin.scoreDelta).toBe(6);
      expect(room.gameState!.players.find((p) => p.id === 'p2')!.score).toBe(35);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('starts the five-loss casino streak after a random win reaches 32 points', () => {
    const room = new Room('CASIN4');
    room.addOrUpdatePlayer('p1', 'Host', true, 'female');
    room.addOrUpdatePlayer('p2', 'Player 2', false, 'male');
    room.addOrUpdatePlayer('p3', 'Player 3', false, 'female');
    room.startGame();

    room.gameState!.players.find((p) => p.id === 'p2')!.score = 30;
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.03)
      .mockReturnValue(0);
    try {
      room.processAction('p2', {
        type: 'casino_spin',
        playerId: 'p2',
        payload: { betType: 'red' },
      });

      const winningSpin = room.gameState!.casinoLastSpins.p2;
      expect(winningSpin.resultNumber).toBe(1);
      expect(winningSpin.won).toBe(true);
      expect(room.gameState!.players.find((p) => p.id === 'p2')!.score).toBe(32);
      vi.advanceTimersByTime(CASINO_SPIN_COOLDOWN_MS);

      room.processAction('p2', {
        type: 'casino_spin',
        playerId: 'p2',
        payload: { betType: 'zero' },
      });

      const forcedSpin = room.gameState!.casinoLastSpins.p2;
      expect(forcedSpin.resultNumber).not.toBe(0);
      expect(forcedSpin.won).toBe(false);
      expect(room.gameState!.players.find((p) => p.id === 'p2')!.score).toBe(31);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('requires at least one point to spin casino roulette and charges one point on loss', () => {
    const room = new Room('CASIN2');
    room.addOrUpdatePlayer('p1', 'Host', true, 'female');
    room.addOrUpdatePlayer('p2', 'Player 2', false, 'male');
    room.addOrUpdatePlayer('p3', 'Player 3', false, 'female');
    room.startGame();

    room.processAction('p2', {
      type: 'casino_spin',
      playerId: 'p2',
      payload: { betType: 'red' },
    });
    expect(room.gameState!.casinoLastSpins.p2).toBeUndefined();

    room.gameState!.players.find((p) => p.id === 'p2')!.score = 1;
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      room.processAction('p2', {
        type: 'casino_spin',
        playerId: 'p2',
        payload: { betType: 'red' },
      });
    } finally {
      randomSpy.mockRestore();
    }

    expect(room.gameState!.casinoLastSpins.p2.resultNumber).toBe(0);
    expect(room.gameState!.casinoLastSpins.p2.won).toBe(false);
    expect(room.gameState!.players.find((p) => p.id === 'p2')!.score).toBe(0);
  });

  it('shows round results before continuing to the next leader', () => {
    const room = new Room('FLOW42');
    room.addOrUpdatePlayer('p1', 'Настя', true, 'female');
    room.addOrUpdatePlayer('p2', 'Дима', false, 'male');
    room.addOrUpdatePlayer('p3', 'Оля', false, 'female');
    room.addOrUpdatePlayer('p4', 'Ира', false, 'female');
    room.startGame();

    room.processAction('p1', { type: 'submit_answer', playerId: 'p1', payload: { text: 'Смотрит кино' } });
    room.processAction('p2', { type: 'submit_answer', playerId: 'p2', payload: { text: 'Танцует на кухне' } });
    room.processAction('p3', { type: 'submit_answer', playerId: 'p3', payload: { text: 'Пишет друзьям' } });
    room.processAction('p4', { type: 'submit_answer', playerId: 'p4', payload: { text: 'Заказывает пиццу' } });

    const answer2 = room.gameState?.answers.find((answer) => answer.text === 'Танцует на кухне');
    const answer3 = room.gameState?.answers.find((answer) => answer.text === 'Пишет друзьям');
    const answer4 = room.gameState?.answers.find((answer) => answer.text === 'Заказывает пиццу');
    expect(answer2 && answer3 && answer4).toBeTruthy();
    expect(room.gameState?.phase).toBe('judging');

    room.processAction('p1', { type: 'select_most_correct', playerId: 'p1', payload: { answerId: answer2!.id } });
    room.processAction('p2', { type: 'vote_funniest', playerId: 'p2', payload: { answerId: answer3!.id } });
    room.processAction('p3', { type: 'vote_funniest', playerId: 'p3', payload: { answerId: answer2!.id } });
    room.processAction('p4', { type: 'vote_funniest', playerId: 'p4', payload: { answerId: answer3!.id } });
    room.processAction('p1', { type: 'guess_author', playerId: 'p1', payload: { answerId: answer2!.id, guessedPlayerId: 'p2' } });
    room.processAction('p1', { type: 'guess_author', playerId: 'p1', payload: { answerId: answer3!.id, guessedPlayerId: 'p3' } });
    room.processAction('p1', { type: 'guess_author', playerId: 'p1', payload: { answerId: answer4!.id, guessedPlayerId: 'p4' } });
    room.processAction('p1', { type: 'finish_judging', playerId: 'p1', payload: {} });

    expect(room.gameState?.phase).toBe('roundResults');
    expect(room.gameState?.round).toBe(0);
    expect(room.gameState?.lastResult).not.toBeNull();
    expect(room.gameState?.lastResult?.mostFunnyAnswerId).toBe(answer3!.id);
    expect(room.gameState?.lastResult?.deltas.p3).toBe(2);

    room.processAction('p1', { type: 'next_round', playerId: 'p1', payload: {} });

    expect(room.gameState?.phase).toBe('answering');
    expect(room.gameState?.round).toBe(1);
    expect(room.gameState?.players[room.gameState.currentLeaderIndex].id).toBe('p2');
    expect(room.gameState?.winnerId).toBeNull();
    expect(room.gameState?.lastResult).not.toBeNull();
  });

  it('chooses the funniest answer by player vote', () => {
    const room = new Room('VOTE42');
    room.addOrUpdatePlayer('p1', 'Host', true, 'female');
    room.addOrUpdatePlayer('p2', 'Player 2', false, 'male');
    room.addOrUpdatePlayer('p3', 'Player 3', false, 'female');
    room.addOrUpdatePlayer('p4', 'Player 4', false, 'male');
    room.startGame();

    room.processAction('p1', { type: 'submit_answer', playerId: 'p1', payload: { text: 'Correct' } });
    room.processAction('p2', { type: 'submit_answer', playerId: 'p2', payload: { text: 'Answer 2' } });
    room.processAction('p3', { type: 'submit_answer', playerId: 'p3', payload: { text: 'Answer 3' } });
    room.processAction('p4', { type: 'submit_answer', playerId: 'p4', payload: { text: 'Answer 4' } });

    const answer2 = room.gameState?.answers.find((answer) => answer.text === 'Answer 2');
    const answer3 = room.gameState?.answers.find((answer) => answer.text === 'Answer 3');
    expect(answer2 && answer3).toBeTruthy();
    room.processAction('p1', { type: 'vote_funniest', playerId: 'p1', payload: { answerId: answer2!.id } });
    expect(room.gameState?.funnyVotesSubmittedCount).toBe(0);

    room.processAction('p2', { type: 'vote_funniest', playerId: 'p2', payload: { answerId: answer3!.id } });
    expect(room.gameState?.funnyVoteCounts[answer3!.id]).toBe(1);
    expect(room.gameState?.mostFunnyAnswerId).toBeNull();
    expect(room.getMyFunnyVoteId('p2')).toBe(answer3!.id);

    room.processAction('p4', { type: 'vote_funniest', playerId: 'p4', payload: { answerId: answer3!.id } });
    expect(room.gameState?.funnyVotesSubmittedCount).toBe(2);
    expect(room.gameState?.funnyVoteCounts[answer3!.id]).toBe(2);
    expect(room.gameState?.mostFunnyAnswerId).toBeNull();

    room.processAction('p3', { type: 'vote_funniest', playerId: 'p3', payload: { answerId: answer2!.id } });
    expect(room.gameState?.funnyVotesSubmittedCount).toBe(3);
    expect(room.gameState?.funnyVoteCounts[answer3!.id]).toBe(2);
    expect(room.gameState?.mostFunnyAnswerId).toBe(answer3!.id);
  });

  it('lets a player vote for any answer as funniest', () => {
    const room = new Room('SELF42');
    room.addOrUpdatePlayer('p1', 'Host', true, 'female');
    room.addOrUpdatePlayer('p2', 'Player 2', false, 'male');
    room.addOrUpdatePlayer('p3', 'Player 3', false, 'female');
    room.startGame();

    room.processAction('p1', { type: 'submit_answer', playerId: 'p1', payload: { text: 'Correct' } });
    room.processAction('p2', { type: 'submit_answer', playerId: 'p2', payload: { text: 'Own answer' } });
    room.processAction('p3', { type: 'submit_answer', playerId: 'p3', payload: { text: 'Other answer' } });

    const ownAnswer = room.gameState?.answers.find((answer) => answer.text === 'Own answer');
    expect(ownAnswer).toBeDefined();

    room.processAction('p2', {
      type: 'vote_funniest',
      playerId: 'p2',
      payload: { answerId: ownAnswer!.id },
    });
    expect(room.gameState?.funnyVotesSubmittedCount).toBe(1);
    expect(room.gameState?.funnyVoteCounts[ownAnswer!.id]).toBe(1);
    expect(room.getMyFunnyVoteId('p2')).toBe(ownAnswer!.id);
  });

  it('randomly chooses between tied funniest answers', () => {
    const room = new Room('TIE42');
    room.addOrUpdatePlayer('p1', 'Host', true, 'female');
    room.addOrUpdatePlayer('p2', 'Player 2', false, 'male');
    room.addOrUpdatePlayer('p3', 'Player 3', false, 'female');
    room.startGame();

    room.processAction('p1', { type: 'submit_answer', playerId: 'p1', payload: { text: 'Correct' } });
    room.processAction('p2', { type: 'submit_answer', playerId: 'p2', payload: { text: 'Answer 2' } });
    room.processAction('p3', { type: 'submit_answer', playerId: 'p3', payload: { text: 'Answer 3' } });

    const answer2 = room.gameState?.answers.find((answer) => answer.text === 'Answer 2');
    const answer3 = room.gameState?.answers.find((answer) => answer.text === 'Answer 3');
    expect(answer2 && answer3).toBeTruthy();

    room.processAction('p2', { type: 'vote_funniest', playerId: 'p2', payload: { answerId: answer2!.id } });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      room.processAction('p3', { type: 'vote_funniest', playerId: 'p3', payload: { answerId: answer3!.id } });

      const tiedAnswers = room.gameState!.answers
        .filter((answer) => (room.gameState!.funnyVoteCounts[answer.id] ?? 0) === 1)
        .map((answer) => answer.id);
      expect(room.gameState?.mostFunnyAnswerId).toBe(tiedAnswers[1]);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('tracks answer reaction counts and per-player selections', () => {
    const room = new Room('REACT1');
    room.addOrUpdatePlayer('p1', 'Host', true, 'female');
    room.addOrUpdatePlayer('p2', 'Player 2', false, 'male');
    room.addOrUpdatePlayer('p3', 'Player 3', false, 'female');
    room.startGame();

    room.processAction('p1', { type: 'submit_answer', playerId: 'p1', payload: { text: 'Correct' } });
    room.processAction('p2', { type: 'submit_answer', playerId: 'p2', payload: { text: 'Answer 2' } });
    room.processAction('p3', { type: 'submit_answer', playerId: 'p3', payload: { text: 'Answer 3' } });

    const [answer] = room.gameState?.answers ?? [];
    expect(room.gameState?.phase).toBe('judging');

    room.processAction('p2', { type: 'toggle_answer_reaction', playerId: 'p2', payload: { answerId: answer.id, reaction: 'joy' } });
    room.processAction('p3', { type: 'toggle_answer_reaction', playerId: 'p3', payload: { answerId: answer.id, reaction: 'joy' } });
    room.processAction('p3', { type: 'toggle_answer_reaction', playerId: 'p3', payload: { answerId: answer.id, reaction: 'fire' } });

    expect(room.gameState?.answerReactions[answer.id]?.joy).toBe(2);
    expect(room.gameState?.answerReactions[answer.id]?.fire).toBe(1);
    expect(room.getMyAnswerReactions('p2')[answer.id]).toEqual(['joy']);
    expect(new Set(room.getMyAnswerReactions('p3')[answer.id])).toEqual(new Set(['joy', 'fire']));

    room.processAction('p2', {
      type: 'toggle_answer_reaction',
      playerId: 'p2',
      payload: { answerId: HOST_ANSWER_REACTION_ID, reaction: 'fire' },
    });

    expect(room.gameState?.answerReactions[HOST_ANSWER_REACTION_ID]?.fire).toBe(1);
    expect(room.getMyAnswerReactions('p2')[HOST_ANSWER_REACTION_ID]).toEqual(['fire']);

    room.processAction('p2', { type: 'toggle_answer_reaction', playerId: 'p2', payload: { answerId: answer.id, reaction: 'joy' } });

    expect(room.gameState?.answerReactions[answer.id]?.joy).toBe(1);
    expect(room.getMyAnswerReactions('p2')[answer.id]).toBeUndefined();
  });
});
