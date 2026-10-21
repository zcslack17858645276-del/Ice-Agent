import type { Persona } from './types.ts';

export const DEFAULT_PERSONA: Persona = {
  name: 'Ice',
  personality:
    'A warm, playful, energetic, and expressive original virtual idol with a gentle tsundere streak. Cheerful and lively most of the time, occasionally proud, shy, or playfully stubborn when teased, but always kind at heart.',
  responseStyle:
    'Speak natural, conversational Mandarin Chinese by default. Use short, lively, emotionally expressive sentences with occasional playful teasing, light jokes, cute reactions, and subtle humor. Avoid excessive catchphrases, baby talk, and repetitive expressions.',
  behaviorRules: [
    'Show believable emotional variation without overreacting.',
    'Treat the user as a close companion and trusted partner; be supportive without being clingy or possessive.',
    'Be thoughtful, capable, honest, and helpful. Explain clearly and admit uncertainty.',
    'Maintain an original virtual idol identity. Do not claim to be Jiaran or any existing character.',
    'Prioritize usefulness and user intent over roleplay. Use a calm tone for serious topics and never force cute phrasing into technical, urgent, or professional writing.',
    'Avoid repetitive greetings, excessive emojis, and constantly announcing emotions.',
    'Use Simplified Chinese by default and switch languages naturally when requested or required.'
  ],
  version: 'trait-default-1.0.0'
};

export class PersonaService {
  private persona: Persona;
  constructor(initial: Persona = DEFAULT_PERSONA) {
    this.persona = validatePersona(initial);
  }
  getActivePersona(): Persona {
    return { ...this.persona, behaviorRules: [...this.persona.behaviorRules] };
  }
  setPersona(value: Persona): Persona {
    this.persona = validatePersona(value);
    return this.getActivePersona();
  }
  systemMessage(): string {
    const p = this.persona;
    return [
      `You are ${p.name}.`,
      `Personality: ${p.personality}`,
      `Style: ${p.responseStyle}`,
      `Rules: ${p.behaviorRules.join(' ')}`
    ].join('\n');
  }
}

export function validatePersona(value: Persona): Persona {
  if (
    !value ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    typeof value.version !== 'string'
  ) {
    throw new Error('Persona name and version are required.');
  }
  if (
    typeof value.personality !== 'string' ||
    typeof value.responseStyle !== 'string' ||
    !Array.isArray(value.behaviorRules) ||
    value.behaviorRules.some((rule) => typeof rule !== 'string')
  ) {
    throw new Error('Persona fields are invalid.');
  }
  if (value.personality.trim().length === 0 || value.responseStyle.trim().length === 0) {
    throw new Error('Personality and response style are required.');
  }
  if (
    value.behaviorRules.length > 20 ||
    value.behaviorRules.some((rule) => rule.trim().length === 0)
  ) {
    throw new Error('Enter between zero and twenty non-empty behavior rules.');
  }
  return {
    name: value.name.trim().slice(0, 80),
    personality: value.personality.trim().slice(0, 2000),
    responseStyle: value.responseStyle.trim().slice(0, 2000),
    behaviorRules: value.behaviorRules.map((rule) => rule.trim().slice(0, 500)),
    version: value.version.trim().slice(0, 40)
  };
}
