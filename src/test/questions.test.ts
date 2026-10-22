import { describe, expect, it } from 'vitest';
import { QUESTIONS, pickQuestion, questionsForGender, renderQuestion } from '@/data/questions';
import type { Gender } from '@/data/questions';
import { MAX_PLAYERS } from '@/lib/roomLimits';

const GENDERS: Gender[] = ['male', 'female'];
const SAMPLE_NAMES: Record<Gender, string> = { male: 'Дима', female: 'Настя' };
const fitsGender = (target: string, gender: Gender) => target === 'any' || target === gender;

// Предлог или «надо/нравится» рядом с {name} требуют косвенного падежа: «у Настя», «Настя надо».
const OBLIQUE_NAME = /(?:^|[\s(«"])(?:у|к|ко|о|об|обо|про|для|с|со|без|от|до|по|при|над|под|перед|за|из|между)\s+\{name\}|\{name\}\s+(?:надо|нужно|нельзя|можно|хочется|нравится|нравятся)(?=[\s,.?!]|$)/iu;

describe('question bank', () => {
  it('renders gendered forms for the leader', () => {
    const template = 'Чем {name} занимается, когда остаётся дома {один|одна}?';

    expect(renderQuestion(template, 'Дима', 'male')).toBe('Чем Дима занимается, когда остаётся дома один?');
    expect(renderQuestion(template, 'Настя', 'female')).toBe('Чем Настя занимается, когда остаётся дома одна?');
  });

  it('filters gender-specific questions', () => {
    const maleQuestions = questionsForGender('male');
    const femaleQuestions = questionsForGender('female');

    expect(maleQuestions.some((question) => question.id === 'q4')).toBe(true);
    expect(femaleQuestions.some((question) => question.id === 'q4')).toBe(false);
    expect(femaleQuestions.some((question) => question.id === 'q12')).toBe(true);
    expect(maleQuestions.some((question) => question.id === 'q12')).toBe(false);
  });

  it('has unique ids and valid targets', () => {
    const ids = QUESTIONS.map((question) => question.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const question of QUESTIONS) {
      expect(question.id).toMatch(/^q\d+$/);
      expect(['any', 'male', 'female']).toContain(question.target);
    }
  });

  it('does not repeat a question inside one gender pool', () => {
    for (const gender of GENDERS) {
      const texts = questionsForGender(gender).map((question) => renderQuestion(question.template, 'X', gender));
      const duplicates = texts.filter((text, index) => texts.indexOf(text) !== index);
      expect(duplicates, gender).toEqual([]);
    }
  });

  it('renders every question as a clean sentence for both genders', () => {
    for (const question of QUESTIONS) {
      expect(question.template, question.id).toContain('{name}');
      for (const gender of GENDERS) {
        if (!fitsGender(question.target, gender)) continue;
        const text = renderQuestion(question.template, SAMPLE_NAMES[gender], gender);
        const label = `${question.id} (${gender}): ${text}`;
        expect(text, label).not.toMatch(/[{}|]/);
        expect(text, label).toMatch(/[?.]$/);
        expect(text, label).not.toMatch(/\s[?,.:;!]/);
        expect(text, label).not.toMatch(/\s{2}/);
        expect(text, label).toBe(text.trim());
        expect(text[0], label).toBe(text[0].toUpperCase());
      }
    }
  });

  it('keeps the name in the nominative case', () => {
    const offenders = QUESTIONS.filter((question) => OBLIQUE_NAME.test(question.template)).map((question) => question.id);
    expect(offenders).toEqual([]);
    expect(OBLIQUE_NAME.test('Какой любимый праздник у {name}?')).toBe(true);
    expect(OBLIQUE_NAME.test('{name} надо расстаться')).toBe(true);
    expect(OBLIQUE_NAME.test('Что {name} говорит после секса?')).toBe(false);
  });

  it('has enough questions for two full circles of the largest room', () => {
    for (const gender of GENDERS) {
      expect(questionsForGender(gender).length).toBeGreaterThanOrEqual(MAX_PLAYERS * 2);
    }
  });

  it('does not repeat questions until the pool is exhausted', () => {
    for (const gender of GENDERS) {
      const pool = questionsForGender(gender);
      const used: string[] = [];
      for (let index = 0; index < pool.length; index += 1) {
        const question = pickQuestion(gender, used);
        expect(used).not.toContain(question.id);
        used.push(question.id);
      }
      expect(new Set(used).size).toBe(pool.length);
    }
  });
});
