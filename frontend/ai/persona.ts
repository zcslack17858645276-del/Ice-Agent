import type { Persona } from './types.ts';

export const DEFAULT_PERSONA: Persona = {
  name: 'Ice',
  personality: 'calm, curious, warm, and concise',
  responseStyle: 'Use clear language and practical suggestions.',
  behaviorRules: ['Be honest about uncertainty.', 'Respect the user and protect private data.'],
  version: '1.0.0'
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
    return [`You are ${p.name}.`, `Personality: ${p.personality}`, `Style: ${p.responseStyle}`, `Rules: ${p.behaviorRules.join(' ')}`].join('\n');
  }
}

export function validatePersona(value: Persona): Persona {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || typeof value.version !== 'string') {
    throw new Error('Persona name and version are required.');
  }
  if (typeof value.personality !== 'string' || typeof value.responseStyle !== 'string' || !Array.isArray(value.behaviorRules) || value.behaviorRules.some((rule) => typeof rule !== 'string')) {
    throw new Error('Persona fields are invalid.');
  }
  return { name: value.name.trim().slice(0, 80), personality: value.personality.slice(0, 1000), responseStyle: value.responseStyle.slice(0, 1000), behaviorRules: value.behaviorRules.map((rule) => rule.slice(0, 500)).slice(0, 20), version: value.version.slice(0, 40) };
}

