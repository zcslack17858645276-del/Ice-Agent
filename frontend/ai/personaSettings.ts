import type { Persona } from './types.ts';
import { DEFAULT_PERSONA, validatePersona } from './persona.ts';

export const personaSettingsKey = 'ice-agent.persona-settings.v1';
export const personaSchemaVersion = 1;

export function readPersonaSettings(storage: Storage = localStorage): Persona {
  try {
    const raw: unknown = JSON.parse(storage.getItem(personaSettingsKey) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return cloneDefaultPersona();
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== personaSchemaVersion) return cloneDefaultPersona();
    return validatePersona(value.persona as Persona);
  } catch {
    return cloneDefaultPersona();
  }
}

export function writePersonaSettings(persona: Persona, storage: Storage = localStorage): void {
  const validated = validatePersona(persona);
  storage.setItem(
    personaSettingsKey,
    JSON.stringify({ schemaVersion: personaSchemaVersion, persona: validated })
  );
}

export function resetPersonaSettings(storage: Storage = localStorage): Persona {
  const persona = cloneDefaultPersona();
  writePersonaSettings(persona, storage);
  return persona;
}

function cloneDefaultPersona(): Persona {
  return { ...DEFAULT_PERSONA, behaviorRules: [...DEFAULT_PERSONA.behaviorRules] };
}
