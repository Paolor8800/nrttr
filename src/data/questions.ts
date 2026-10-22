// «Узнай друзей» — банк вопросов.
//
// Каждый вопрос — это шаблон с подстановками:
//   {name}   — имя ведущего (того, про кого задаётся вопрос);
//   {м|ж}    — пара «форма для мужчины|форма для женщины», выбирается
//              автоматически по полу ведущего (gender).
//
// Имя подставляется как есть, в именительном падеже, поэтому формулируйте
// вопрос так, чтобы имя было подлежащим: «Чего {name} боится больше всего?»,
// а не «Какой главный страх {name}?» (получится «страх Настя»).
// Если без косвенного падежа не обойтись: «{name}: какое у {него|неё} …?».
// Для вопросов 'any' всё, что зависит от пола, оформляйте через {м|ж}.
//
// target — кому можно задать вопрос (про кого он):
//   'any'    — любому, окончания адаптируются по полу;
//   'male'   — только мужчине;
//   'female' — только женщине.

export type Gender = 'male' | 'female';
export type QuestionTarget = 'any' | Gender;

export interface Question {
  id: string;
  /** Шаблон с токенами {name} и {м|ж}. */
  template: string;
  target: QuestionTarget;
}

export const QUESTIONS: Question[] = [
  { id: 'q1',  target: 'any',    template: 'Чем {name} обычно занимается, когда остаётся дома {один|одна}?' },
  { id: 'q2',  target: 'any',    template: 'О чём думает {name}, стоя {голым|голой} перед зеркалом?' },
  { id: 'q3',  target: 'any',    template: 'Представим, что {name} впервые {пришёл|пришла} на эротический массаж. Какую первую фразу {он|она} скажет, зайдя туда?' },
  { id: 'q4',  target: 'male',   template: 'Что {name} говорит девушке после секса?' },
  { id: 'q5',  target: 'any',    template: 'О чём чаще всего думает {name}?' },
  { id: 'q6',  target: 'any',    template: 'Что {name} сделает через неделю, оказавшись на необитаемом острове?' },
  { id: 'q7',  target: 'male',   template: 'Если {name} закажет проститутку, что он скажет ей перед началом?' },
  { id: 'q8',  target: 'any',    template: 'Какой праздник {name} любит больше всего?' },
  { id: 'q9',  target: 'male',   template: 'Что {name} говорит девушке перед сексом?' },
  { id: 'q10', target: 'any',    template: 'Что {name} считает смешным?' },
  { id: 'q11', target: 'male',   template: 'Каких девушек любит {name}?' },
  { id: 'q12', target: 'female', template: 'Что скажет {name}, если её застанут за просмотром порно?' },
  { id: 'q13', target: 'female', template: 'Как часто {name} думает о гей-сексе?' },
  { id: 'q14', target: 'any',    template: 'Какой самый стыдный или странный запрос {name} {оставил|оставила} в истории браузера?' },
  { id: 'q15', target: 'female', template: 'Какой анекдот {name} любит больше всего?' },
  { id: 'q16', target: 'any',    template: 'О каких извращениях фантазирует {name}?' },
  { id: 'q17', target: 'male',   template: 'Что говорит {name} девушке перед началом секса?' },
  { id: 'q18', target: 'any',    template: '{name} {должен|должна} расстаться со своим партнёром по СМС. Что будет написано в этом СМС?' },
  { id: 'q19', target: 'female', template: 'О чём {name} думает после мастурбации?' },
  { id: 'q20', target: 'male',   template: 'Какую кличку получил бы {name}, если бы был геем?' },
  { id: 'q21', target: 'any',    template: 'Если бы {name} {был|была} {певцом|певицей} эстрады, какой псевдоним у {него|неё} был бы?' },
  { id: 'q22', target: 'male',   template: 'Если бы {name} был порноактёром, какой псевдоним он бы себе взял?' },
  { id: 'q23', target: 'female', template: 'Что {name} говорит после секса?' },
  { id: 'q24', target: 'male',   template: 'Девушка весом 120 кг готова заплатить, чтобы {name} переспал с ней. На какую сумму {name} согласится?' },
  { id: 'q25', target: 'any',    template: 'Кого или что больше всего ненавидит {name}?' },
  { id: 'q26', target: 'any',    template: 'За какую сумму {name} согласится продать журналу Playboy свои обнажённые фото?' },
  { id: 'q28', target: 'any',    template: 'Скучающий миллиардер предлагает любые деньги за то, чтобы ежедневно получать видео, как {name} мастурбирует. На какую сумму согласится {name}?' },
  { id: 'q29', target: 'any',    template: 'Чем гордится {name}?' },
  { id: 'q30', target: 'any',    template: 'Чего {name} боится больше всего?' },
  { id: 'q31', target: 'male',   template: 'О чём {name} думает после мастурбации?' },
  { id: 'q33', target: 'any',    template: 'Что {name} больше всего любит в сексе?' },
  { id: 'q34', target: 'male',   template: 'Что {name} говорит девушке, когда хочет, чтобы она осталась у него на ночь?' },
  { id: 'q35', target: 'male',   template: 'Что скажет {name}, если случайно застанет друзей за занятием сексом?' },
  { id: 'q36', target: 'male',   template: 'О чём {name} думает при первом поцелуе с девушкой?' },
  { id: 'q37', target: 'male',   template: 'Что {name} делает, когда очень хочет произвести впечатление?' },
  { id: 'q38', target: 'male',   template: 'Как {name} ведёт себя, когда ревнует?' },
  { id: 'q39', target: 'male',   template: 'Что {name} пишет бывшей спустя год после того, как они расстались?' },
  { id: 'q40', target: 'male',   template: 'Какой комплимент {name} слышал в последний раз?' },
  { id: 'q41', target: 'male',   template: 'Что {name} скажет девушке, если она ему нужна только на одну ночь?' },
  { id: 'q42', target: 'male',   template: 'Что {name} делает после расставания с девушкой?' },
  { id: 'q43', target: 'male',   template: 'Как {name} пытается скрыть, что уже влюбился?' },
  { id: 'q44', target: 'female', template: 'Что {name} говорит парню, когда хочет, чтобы он побегал за ней?' },
  { id: 'q45', target: 'female', template: 'Как {name} намекает, что ей уже скучно в переписке?' },
  { id: 'q46', target: 'female', template: 'Что {name} напишет бывшему?' },
  { id: 'q47', target: 'female', template: 'О чём {name} думает перед свиданием, пока выбирает бельё?' },
  { id: 'q48', target: 'female', template: 'Какой самый жёсткий отказ может дать парню {name}?' },
  { id: 'q49', target: 'female', template: 'Что {name} говорит после удачного секса?' },
  { id: 'q50', target: 'female', template: 'Как {name} ведёт себя, когда парень ей очень нравится?' },
  { id: 'q51', target: 'female', template: 'Что {name} делает, чтобы проверить, насколько парень ей верен?' },
  { id: 'q52', target: 'female', template: 'Какой секрет прячет {name}?' },
  { id: 'q53', target: 'female', template: 'Что {name} делает, когда хочет внимания?' },
  { id: 'q54', target: 'any',    template: 'Что {name} чаще всего делает, когда никто не видит?' },
  { id: 'q55', target: 'any',    template: 'Какой самый стыдный поступок {совершил|совершила} {name}?' },
  { id: 'q56', target: 'any',    template: 'Что {name} никогда не признает о себе?' },
  { id: 'q57', target: 'any',    template: 'Как ведёт себя {name}, когда {пьяный|пьяная}?' },
  { id: 'q58', target: 'any',    template: 'На что {name} тратит деньги без единого сомнения?' },
  { id: 'q59', target: 'any',    template: 'Как {name} выкручивается из неловкой ситуации?' },
  { id: 'q60', target: 'any',    template: 'О чём {name} думает перед сном?' },
  { id: 'q61', target: 'any',    template: 'Что {name} больше всего не выносит в людях?' },
  { id: 'q62', target: 'any',    template: 'Что {name} скажет, если {его|её} поймают на краже?' },
  { id: 'q63', target: 'any',    template: 'Чем гордится {name}, хотя это выглядит сомнительно?' },
  { id: 'q64', target: 'any',    template: 'О чём думает {name} прямо сейчас?' },
  { id: 'q65', target: 'any',    template: 'Что {name} говорит во время секса?' },
  { id: 'q66', target: 'any',    template: 'Какую кличку {получил|получила} бы {name}, если бы её придумали сейчас?' },
  { id: 'q67', target: 'any',    template: '{name}: опишите {его|её} крылатой фразой или поговоркой.' },
  { id: 'q68', target: 'any',    template: '{name}: какое у {него|неё} худшее качество?' },
  { id: 'q69', target: 'any',    template: '{name}: как зовут {его|её} лучшую подругу или лучшего друга?' },
  { id: 'q70', target: 'any',    template: 'Какую позу в сексе {name} любит больше всего?' },
];


/** Разворачивает токены {м|ж} и {name} согласно полу и имени ведущего. */
export function renderQuestion(template: string, name: string, gender: Gender): string {
  const withForms = template.replace(/\{([^{}|]*)\|([^{}|]*)\}/g, (_m, male, female) =>
    gender === 'male' ? male : female,
  );
  return withForms.replace(/\{name\}/g, name);
}

/** Вопросы, подходящие ведущему данного пола. */
export function questionsForGender(gender: Gender): Question[] {
  return QUESTIONS.filter((q) => q.target === 'any' || q.target === gender);
}

/** Случайный вопрос для ведущего, по возможности не повторяя уже заданные. */
export function pickQuestion(gender: Gender, usedIds: string[] = []): Question {
  const pool = questionsForGender(gender);
  const fresh = pool.filter((q) => !usedIds.includes(q.id));
  const from = fresh.length > 0 ? fresh : pool;
  return from[Math.floor(Math.random() * from.length)];
}
