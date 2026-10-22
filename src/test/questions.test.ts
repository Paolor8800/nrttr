import { describe, expect, it } from 'vitest';
import { questionsForGender, renderQuestion } from '@/data/questions';

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
});
