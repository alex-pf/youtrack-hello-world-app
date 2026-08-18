import Anthropic from '@anthropic-ai/sdk';
import {betaZodOutputFormat} from '@anthropic-ai/sdk/helpers/beta/zod';
import {z} from 'zod';

// ─── Plan schema ────────────────────────────────────────────────────────────
//
// Dates are deliberately NEVER absolute in the AI's output — LLMs are
// unreliable at wall-clock arithmetic. Every action instead carries an
// offset (days/hours/minutes) from `generatedAtMs` (the moment plan.mjs
// runs), which plan.mjs resolves to an absolute runAtMs once, right after
// the response comes back. See docs note in the user's brief: "скрипт
// фиксирует дату запуска и дальше в сете указано +N дней, часов, минут".

const ActionSchema = z.object({
  type: z.enum(['create_issue', 'transition', 'set_estimated_date']),
  // Client-assigned symbolic id: for create_issue, a NEW id the AI invents
  // (e.g. "synth-1"); for transition/set_estimated_date, MUST reference a
  // syntheticId from the "existing open synthetic issues" list in the prompt.
  syntheticId: z.string(),
  offsetDays: z.number().int().min(0).max(120),
  offsetHours: z.number().int().min(0).max(23),
  offsetMinutes: z.number().int().min(0).max(59),
  // create_issue only — must be one of the allowed group-field values.
  issueType: z.string().optional(),
  // transition only — must be one of the project's known state names.
  targetStatus: z.string().optional(),
  // set_estimated_date only — days from the action's own runAt to the
  // estimated date value being set (can be negative for already-overdue).
  estimatedDateOffsetDays: z.number().int().optional(),
});

const PlanSchema = z.object({
  notes: z.string().describe('Brief rationale for this plan, for human debugging — not used by the script.'),
  actions: z.array(ActionSchema).max(40),
});

// ─── Prompt construction ────────────────────────────────────────────────────

function buildPrompt({config, structure, openIssues, dayLabel, isPartialDay}) {
  const {target, synthetic} = config;
  const allowedTypes = structure.groupFields[target.groupByField] ?? [];
  const allowedStates = structure.states.map(s => s.name);

  const openIssuesBlock = openIssues.length
    ? openIssues.map(i => `- ${i.syntheticId} (${i.idReadable}): type=${i.type}, status=${i.currentStatus}, created ${Math.round((Date.now() - i.createdAtMs) / 86400000)}d ago`).join('\n')
    : '(none currently open)';

  return `Ты планируешь действия для генератора синтетических тестовых данных в YouTrack на ${dayLabel}.${isPartialDay ? ' Это ПЕРЕПЛАНИРОВАНИЕ на оставшуюся часть дня (структура проекта изменилась с прошлого плана).' : ''}

Все синтетические задачи помечаются префиксом "${synthetic.summaryPrefix}" в summary и тегом "${synthetic.tag}" — сгенерированные тобой действия должны укладываться в этот контракт, ты сам префикс/тег не указываешь, это делает скрипт.

Доступные статусы проекта (в порядке из воркфлоу, если он линейный): ${allowedStates.join(' -> ')}
Доступные значения поля группировки "${target.groupByField}": ${allowedTypes.join(', ')}

Целевые параметры лид-тайма (время от первого статуса до последнего) по типам:
${Object.entries(target.leadTime).map(([type, t]) => `- ${type}: p50 ≈ ${t.p50Days} дн., p80 ≈ ${t.p80Days} дн., разброс: ${t.spread}`).join('\n')}

Целевой темп создания новых задач: ${target.newIssuesPerWeek} в неделю (распредели пропорционально на сегодня, не обязательно создавать каждый день).

Сейчас открытые (ещё не Done/резолвнутые) синтетические задачи:
${openIssuesBlock}

Сформируй план действий на сегодня (${config.schedule.actionsPerDayRange[0]}-${config.schedule.actionsPerDayRange[1]} действий, в рабочие часы ${config.schedule.workingHours.startHour}:00-${config.schedule.workingHours.endHour}:00 по ${config.schedule.timezone}):
- Создание новых задач (create_issue) — если сегодня подходящий день по темпу.
- Переходы существующих открытых задач в следующий статус (transition) — распредели так, чтобы суммарное время от старта до финального статуса в среднем соответствовало целевым p50/p80 для типа этой задачи (учитывай, сколько задача уже "прожила", см. "created Nd ago" выше).
- Опционально: set_estimated_date для задачи, у которой ещё не выставлена дата.

ВАЖНО: указывай offsetDays/offsetHours/offsetMinutes как СМЕЩЕНИЕ ОТ ТЕКУЩЕГО МОМЕНТА (не абсолютное время) — в пределах сегодняшнего рабочего окна. Не изобретай статусы или типы, которых нет в списках выше.`;
}

// ─── Call Claude ────────────────────────────────────────────────────────────

export async function generatePlan({config, structure, openIssues, dayLabel, isPartialDay}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set (see .env.local.example)');

  const client = new Anthropic({apiKey});
  const prompt = buildPrompt({config, structure, openIssues, dayLabel, isPartialDay});

  const response = await client.beta.messages.parse({
    model: config.ai.model,
    max_tokens: 4096,
    messages: [{role: 'user', content: prompt}],
    output_format: betaZodOutputFormat(PlanSchema),
  });

  if (!response.parsed_output) {
    throw new Error(`AI plan response failed schema validation: ${JSON.stringify(response.content).slice(0, 500)}`);
  }
  return response.parsed_output;
}
