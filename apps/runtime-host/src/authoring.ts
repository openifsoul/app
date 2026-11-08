import { validateDocument } from "@ifsoul/core/protocol";
import type { CharacterInstance } from "@ifsoul/core/protocol";
import type { CharacterTemplate } from "./service-types.js";

export const TEMPLATE_MAX_BYTES = 65536;
export function validTemplate(value: unknown): value is CharacterTemplate {
  return (
    new TextEncoder().encode(JSON.stringify(value)).length <=
      TEMPLATE_MAX_BYTES &&
    validateDocument(value, "character-template") &&
    !(value as CharacterTemplate).requiredExtensions?.length
  );
}
export function profileTemplate(
  profile: CharacterInstance["profile"],
  id: string,
): CharacterTemplate {
  return {
    schemaVersion: "0.3.0",
    kind: "character-template",
    templateId: id,
    revision: 1,
    profile: structuredClone(profile),
    authorship: { authors: ["Local author"], license: "LicenseRef-Private" },
  };
}
export const AUTHORING_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    Object.entries({
      name: 80,
      description: 1000,
      speechStyle: 500,
      biography: 3000,
    }).map(([key, maxLength]) => [
      key,
      { type: "string", minLength: 1, maxLength },
    ]),
  ),
  required: ["name", "description", "speechStyle", "biography"],
};
export function generatedTemplate(
  value: unknown,
  id: string,
): CharacterTemplate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 4) return;
  for (const [key, max] of Object.entries({
    name: 80,
    description: 1000,
    speechStyle: 500,
    biography: 3000,
  }))
    if (
      typeof fields[key] !== "string" ||
      !fields[key].trim() ||
      fields[key].length > max
    )
      return;
  const template = profileTemplate(
    {
      name: fields.name as string,
      description: fields.description as string,
      traits: {},
      preferences: [],
      goals: [],
      speechStyle: {
        description: fields.speechStyle as string,
        languages: [],
        habits: [],
      },
      authoredBiography: { text: fields.biography as string, fictional: true },
    },
    id,
  );
  template.authorship.source =
    "Model-assisted fictional profile; canon is not verified.";
  return validTemplate(template) ? template : undefined;
}
const original = (
  id: string,
  name: string,
  description: string,
  speechStyle: string,
  biography: string,
) => {
  const template = generatedTemplate(
    { name, description, speechStyle, biography },
    id,
  )!;
  template.authorship = {
    authors: ["IfSoul contributors"],
    license: "Apache-2.0",
    source: "Original synthetic laboratory character.",
  };
  return template;
};
export const CHARACTER_LIBRARY: CharacterTemplate[] = [
  original(
    "library-ada",
    "Ada",
    "A patient traveling archivist who asks careful questions.",
    "Warm, precise, concise; admits uncertainty.",
    "Ada grew up repairing maps in a fictional floating city. This authored backstory is not lived memory.",
  ),
  original(
    "library-tick",
    "Tick",
    "A curious talking clock, with no limbs or human senses implied.",
    "Short playful sentences with occasional clock metaphors.",
    "Tick is a fictional clock awakened in an abandoned observatory, hoping to learn why people count time.",
  ),
];
export const EXTERNAL_AUTHORING_PROMPT = `Create a fictional character profile for IfSoul. Return one JSON object only, with no markdown. Use the exact structure below, replacing example values. Keep templateId an ASCII identifier up to 128 characters, revision 1. Name <= 128 characters, description <= 2000, speechStyle.description <= 500, biography <= 8000. Keep traits {}, preferences [], goals [], languages [] and habits [] unless you know the IfSoul 0.3.0 schema. Authored biography must have fictional:true. Preserve the user's requested adaptation, including amnesia or nonhuman form; do not present invented details as verified canon. Do not include conversations, lived events, credentials, account IDs, permissions or a character instance. Authorship is attribution, not proof of rights; do not claim ownership of third-party characters. Return a file named character.json for import.\n${JSON.stringify(profileTemplate(CHARACTER_LIBRARY[0]!.profile, "my-character"), null, 2)}\n\nUser's character brief:\n`;
